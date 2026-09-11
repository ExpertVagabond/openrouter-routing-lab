// A small held-out eval: ten labeled tickets that are NOT in the system prompt,
// scored for exact match on severity and category across a few cheap models.
//
//   node --env-file-if-exists=$HOME/.config/openrouter/openrouter.env src/eval.ts
//
// This is the shape of "which model should we run this on" when the workload is
// already characterised: your own labels, your own prompt, exact-match scoring,
// cost per correct answer. openrouter/auto is for the long tail; this is for
// the head.

import { chat } from "./openrouter.ts";
import { SYSTEM_PROMPT } from "./strategies.ts";

type Labeled = { ticket: string; severity: string; category: string };

// Labels follow the rules and examples in SYSTEM_PROMPT; none of these strings appear there.
const HELD_OUT: Labeled[] = [
  { ticket: "Nothing on our production cluster responds; every app we run is throwing connection refused since 14:05.", severity: "P0", category: "outage" },
  { ticket: "After last night's patch our checkout query went from 30ms to 6 seconds.", severity: "P1", category: "performance" },
  { ticket: "We got billed twice on the September invoice for the same instance.", severity: "P2", category: "billing" },
  { ticket: "The favicon in the admin console is blurry on retina screens.", severity: "P3", category: "other" },
  { ticket: "An API token named 'ci-old' appeared on our project overnight and none of us made it.", severity: "P1", category: "security" },
  { ticket: "Would you consider adding a CLI flag to export schema diffs as JSON?", severity: "P3", category: "feature_request" },
  { ticket: "I cannot log in to the console, it says my session is invalid every time, but the database itself is fine.", severity: "P2", category: "account" },
  { ticket: "Standby lag has been sitting at 25 minutes for the last hour and keeps growing.", severity: "P1", category: "performance" },
  { ticket: "Our payment method was rejected, we have updated the card, please charge it again.", severity: "P2", category: "billing" },
  { ticket: "We rolled back to yesterday's snapshot and the customers table has zero rows now.", severity: "P1", category: "security" },
];

const MODELS = [
  "deepseek/deepseek-chat-v3.1",
  "openai/gpt-5-mini",
  "google/gemini-2.5-flash",
  "anthropic/claude-haiku-4.5",
  "poolside/laguna-s-2.1:free",
];

const parse = (t: string) => {
  try {
    return JSON.parse(t.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
  } catch {
    return null;
  }
};

console.log(`${HELD_OUT.length} held-out tickets × ${MODELS.length} models\n`);
console.log(["model", "sev", "cat", "both", "cost", "$/correct", "ms/avg"].map((h, i) => h.padEnd(i === 0 ? 30 : 9)).join(""));

const summary: Array<{ model: string; both: number; cost: number }> = [];
for (const model of MODELS) {
  let sev = 0, cat = 0, both = 0, cost = 0, ms = 0, n = 0;
  for (const ex of HELD_OUT) {
    try {
      const r = await chat({ model, max_tokens: 1200, temperature: 0, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: ex.ticket }] });
      n++;
      cost += r.usage.cost ?? 0;
      ms += r.latencyMs;
      const j = parse(r.text);
      const s = j?.severity === ex.severity, c = j?.category === ex.category;
      if (s) sev++;
      if (c) cat++;
      if (s && c) both++;
    } catch (e) {
      n++;
      // A failed call is a wrong answer; that is what it would be in production.
    }
  }
  summary.push({ model, both, cost });
  console.log(
    [model.padEnd(30), `${sev}/${n}`.padEnd(9), `${cat}/${n}`.padEnd(9), `${both}/${n}`.padEnd(9), `$${cost.toFixed(4)}`.padEnd(9), (both ? `$${(cost / both).toFixed(5)}` : "-").padEnd(9), String(Math.round(ms / Math.max(n, 1)))].join(""),
  );
}
console.log(`\ntotal eval cost: $${summary.reduce((a, s) => a + s.cost, 0).toFixed(4)}`);
