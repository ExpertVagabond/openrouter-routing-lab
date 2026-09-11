// Each strategy is one routing lever from the provider-routing docs, applied to
// the same workload, so the report compares levers and not prompts.
//
// The workload is a customer-support triage task with a long, fixed system
// prompt. Long fixed prefix + varying user turn is the shape where prompt
// caching and sticky routing pay off, which is why it is the one to demo.

import { chat, endpoints, type ChatRequest, type ChatResult } from "./openrouter.ts";

export const WORKHORSE = "deepseek/deepseek-chat-v3.1"; // many providers -> routing is visible
export const CACHE_MODEL = "anthropic/claude-haiku-4.5"; // explicit cache_control, 0.1x cache reads

export const SYSTEM_PROMPT = `You are the first-line support triage agent for Northwind Cloud, a managed Postgres provider.
Classify each incoming ticket and produce a JSON object with exactly these keys:
- "category": one of "billing", "outage", "performance", "security", "feature_request", "account", "other"
- "severity": one of "P0", "P1", "P2", "P3" (P0 = production down for many customers, P3 = cosmetic)
- "needs_human": boolean, true when the ticket mentions legal action, data loss, a security breach, or a refund over $500
- "summary": one sentence, at most 20 words, no customer PII
- "first_reply": a two-sentence reply in plain English that acknowledges the issue and states the next step

Rules:
1. Never promise a refund, credit, or timeline. Say what will happen next, not when.
2. If the customer reports data loss, severity is at least P1 and needs_human is true.
3. If the customer is locked out of the console, category is "account" unless they also report an outage.
4. If two categories apply, choose the one with the higher severity.
5. Do not include markdown fences. Output the JSON object only.

Reference severity examples:
- "Our primary is unreachable and all app traffic is failing" -> P0, outage
- "Queries that took 40ms now take 4s since the 03:00 maintenance window" -> P1, performance
- "Invoice shows two charges for August" -> P2, billing
- "Dark mode in the console has a light-colored footer" -> P3, other
- "Someone I do not recognise has an API key on our project" -> P1, security, needs_human true
- "Can you add a Terraform resource for read replicas?" -> P3, feature_request
- "We restored from a snapshot and three tables are empty" -> P1, security or outage as applicable, needs_human true
- "Card declined, please retry with the new card on file" -> P2, billing
- "Console says my email is unverified but I have clicked the link twice" -> P2, account
- "Replica lag is at 20 minutes and rising" -> P1, performance`;

export const TICKET =
  "Hi, since about 06:10 UTC our EU-west primary is accepting connections but every write times out after 30s. Reads are fine. We have a customer launch at 09:00 and I need to know whether to fail over to the replica ourselves. Ticket opened by our on-call, org id 8813.";

export type Strategy = {
  name: string;
  lever: string; // the one routing knob this row demonstrates
  why: string; // the customer situation where you reach for it
  // Number of sequential calls; >1 lets caching/sticky rows show the warm second call.
  calls?: number;
  build: () => Promise<ChatRequest>;
};

const base = (model: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model,
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: TICKET },
  ],
  max_tokens: 300,
  temperature: 0,
  user: "lab-user-1", // constant end-user id so sticky routing can pin the endpoint
  ...extra,
});

export const strategies: Strategy[] = [
  {
    name: "default",
    lever: "(none)",
    why: "What a customer gets with no provider object: load-balanced by inverse square of price, outage providers excluded for 30s.",
    build: async () => base(WORKHORSE),
  },
  {
    name: "sort:price",
    lever: "provider.sort = price",
    why: "Batch or offline workloads where the cheapest endpoint wins and load balancing is not wanted.",
    build: async () => base(WORKHORSE, { provider: { sort: "price" } }),
  },
  {
    name: "sort:latency",
    lever: "provider.sort = latency",
    why: "Interactive UI where the first token matters more than a few cents per million.",
    build: async () => base(WORKHORSE, { provider: { sort: "latency" } }),
  },
  {
    name: "order+fallbacks",
    lever: "provider.order + allow_fallbacks",
    why: "Customer has a contractual or quality preference for specific providers but must not go down if they do. Order derived live from the endpoints API, not hardcoded.",
    build: async () => {
      const eps = (await endpoints(WORKHORSE)).filter((e) => e.uptime30m == null || e.uptime30m > 95);
      const cheapestTwo = eps.sort((a, b) => a.promptPerM - b.promptPerM).slice(0, 2).map((e) => e.tag);
      return base(WORKHORSE, { provider: { order: cheapestTwo, allow_fallbacks: true } });
    },
  },
  {
    name: "zdr",
    lever: "provider.zdr = true",
    why: "Regulated customer: only Zero-Data-Retention endpoints. Note the smaller provider pool, so pair with model fallbacks.",
    build: async () => base(WORKHORSE, { provider: { zdr: true, data_collection: "deny" } }),
  },
  {
    name: ":floor",
    lever: "model suffix :floor",
    why: "Shorthand for sort=price plus flex service tier. Same as sort:price for most customers, one string change.",
    build: async () => base(`${WORKHORSE}:floor`),
  },
  {
    name: ":nitro",
    lever: "model suffix :nitro",
    why: "Shorthand for sort=throughput plus priority tier. Reach for it on long generations.",
    build: async () => base(`${WORKHORSE}:nitro`),
  },
  {
    name: "model-fallbacks",
    lever: "models = [...]",
    why: "Fail across models, not just providers. First model that returns wins; the response `model` field shows which.",
    build: async () => base(CACHE_MODEL, { models: [CACHE_MODEL, "google/gemini-2.5-flash", WORKHORSE] }),
  },
  {
    name: "auto:low",
    lever: "openrouter/auto + cost_tier=low",
    why: "Let community spend-share pick the model for this task type, cheapest band. The response `model` field shows what it chose.",
    build: async () => base("openrouter/auto", { plugins: [{ id: "auto-router", cost_tier: "low" }] }),
  },
  {
    name: "auto:high",
    lever: "openrouter/auto + cost_tier=high",
    why: "Same router, more capable band. Compare cost and the chosen model against auto:low.",
    build: async () => base("openrouter/auto", { plugins: [{ id: "auto-router", cost_tier: "high" }] }),
  },
  {
    name: "cache+sticky",
    lever: "cache_control on the system prompt, constant `user`",
    why: "Second call should show cached_tokens > 0 and lower cost. This is the 'cheapest token is a cached one' conversation.",
    calls: 2,
    build: async () => ({
      ...base(CACHE_MODEL),
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: TICKET },
      ],
    }),
  },
];

export type Row = {
  strategy: Strategy;
  call: number;
  result?: ChatResult;
  error?: string;
};

export async function runStrategy(s: Strategy): Promise<Row[]> {
  const rows: Row[] = [];
  const n = s.calls ?? 1;
  for (let i = 1; i <= n; i++) {
    try {
      const req = await s.build();
      rows.push({ strategy: s, call: i, result: await chat(req) });
    } catch (e) {
      rows.push({ strategy: s, call: i, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return rows;
}
