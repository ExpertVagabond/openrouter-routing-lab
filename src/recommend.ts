// Turn the measured rows into a recommendation for a customer goal.
//
// This is the part of the FDE job that is judgment, not plumbing: given the
// same task run through every lever, which one do you tell the customer to
// ship for *their* goal? The measurements are in `rows`; the rule is yours.

import type { Row } from "./strategies.ts";

export type Goal = "cheapest" | "fastest" | "balanced" | "compliant";

export type Recommendation = {
  strategy: string; // strategy.name to ship
  reason: string; // one sentence a customer engineer would accept
};

// Rows that produced a usable result, with the numbers pulled up for convenience.
export function scored(rows: Row[]) {
  return rows
    .filter((r) => r.result)
    .map((r) => ({
      name: r.strategy.name,
      call: r.call,
      lever: r.strategy.lever,
      provider: r.result!.provider,
      model: r.result!.model,
      latencyMs: r.result!.latencyMs,
      cost: r.result!.usage.cost ?? Number.NaN,
      cached: r.result!.usage.prompt_tokens_details?.cached_tokens ?? 0,
      zdr: r.strategy.name === "zdr",
    }));
}

// TODO(Matthew): implement the rule.
//
// Inputs: `scored(rows)` (one entry per call; the cache+sticky strategy has call 1 and 2).
// Output: which strategy to ship for the goal, and why, in one sentence.
//
// Things worth deciding, because a customer will ask:
//   - "cheapest": is it lowest measured cost, or lowest cost among rows within N ms of the fastest?
//   - "fastest": raw latency, or latency after excluding rows that cost more than 2x the median?
//   - "balanced": pick a scalarisation (cost * latency? rank-sum?) and be able to defend it.
//   - "compliant": only the zdr row qualifies; if it errored, say so instead of falling back silently.
//   - For cache+sticky, use call 2 (the warm call) as its representative number, not call 1.
export function recommend(rows: Row[], goal: Goal): Recommendation | null {
  const s = scored(rows);
  if (s.length === 0) return null;
  void goal;
  return null; // replace with your rule
}
