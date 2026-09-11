// Minimal OpenRouter client. No SDK on purpose: an FDE has to be able to show a
// customer the raw request and the raw response, and point at the fields that
// tell them which provider actually served, what it cost, and what was cached.

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

export type Message = { role: "system" | "user" | "assistant"; content: unknown };

// Only the request fields this lab exercises. See
// https://openrouter.ai/docs/features/provider-routing for the full `provider` object.
export type ChatRequest = {
  model: string;
  messages: Message[];
  models?: string[]; // model-level fallback list
  provider?: {
    order?: string[];
    allow_fallbacks?: boolean;
    only?: string[];
    ignore?: string[];
    sort?: "price" | "throughput" | "latency";
    zdr?: boolean;
    data_collection?: "allow" | "deny";
    require_parameters?: boolean;
  };
  plugins?: Array<Record<string, unknown>>;
  max_tokens?: number;
  temperature?: number;
  user?: string; // stable per end-user id; drives sticky routing + caching
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number; // USD, always present on non-streaming responses
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type ChatResult = {
  id: string;
  model: string; // the model that actually ran (matters for openrouter/auto and `models` fallbacks)
  provider: string; // the endpoint that actually served
  text: string;
  finishReason: string; // "length" means max_tokens cut the answer (reasoning models burn it first)
  usage: Usage;
  latencyMs: number;
  raw: unknown;
};

export class OpenRouterError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`OpenRouter ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set (expected in ~/.config/openrouter/openrouter.env)");

  const started = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Optional attribution headers; they make the app show up on openrouter.ai/rankings.
      "HTTP-Referer": "https://github.com/ExpertVagabond/openrouter-routing-lab",
      "X-Title": "openrouter-routing-lab",
    },
    body: JSON.stringify(req),
  });
  const latencyMs = Math.round(performance.now() - started);

  if (!res.ok) throw new OpenRouterError(res.status, await res.text());
  const data = (await res.json()) as any;
  // Some upstream failures come back as 200 with an `error` object inside.
  if (data.error) throw new OpenRouterError(data.error.code ?? 200, JSON.stringify(data.error));

  return {
    id: data.id,
    model: data.model,
    provider: data.provider ?? "?",
    text: data.choices?.[0]?.message?.content ?? "",
    finishReason: data.choices?.[0]?.finish_reason ?? "?",
    usage: data.usage,
    latencyMs,
    raw: data,
  };
}

// GET /models/:author/:slug/endpoints — the per-provider price/latency table for one model.
// Used to derive a real `provider.order` at runtime instead of hardcoding provider slugs.
export type Endpoint = {
  provider: string;
  tag: string; // e.g. "deepinfra/fp4" — accepted by provider.order / only / ignore
  promptPerM: number;
  completionPerM: number;
  quant: string;
  uptime30m: number | null;
  latency30m: number | null;
  throughput30m: number | null;
  implicitCaching: boolean;
};

export async function endpoints(model: string): Promise<Endpoint[]> {
  const res = await fetch(`${BASE}/models/${model}/endpoints`);
  if (!res.ok) throw new OpenRouterError(res.status, await res.text());
  const data = (await res.json()) as any;
  return (data.data?.endpoints ?? []).map((e: any) => ({
    provider: e.provider_name,
    tag: e.tag,
    promptPerM: Number(e.pricing?.prompt ?? 0) * 1e6,
    completionPerM: Number(e.pricing?.completion ?? 0) * 1e6,
    quant: e.quantization ?? "unknown",
    uptime30m: e.uptime_last_30m ?? null,
    latency30m: e.latency_last_30m ?? null,
    throughput30m: e.throughput_last_30m ?? null,
    implicitCaching: Boolean(e.supports_implicit_caching),
  }));
}
