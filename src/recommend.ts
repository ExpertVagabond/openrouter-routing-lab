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

// The rule. Deliberately small so it can be argued with line by line.
//
//   cheapest:  lowest cost among rows that returned a usable answer. Ties go to
//              the lower latency. The eval (src/eval.ts) is the check that
//              "cheapest" is not also "wrong": DeepSeek was 10/10 at $0.0026.
//   fastest:   lowest latency among rows costing no more than 2x the median.
//              A 200ms answer at 10x the price is not what a customer means by
//              "fast"; it is what they mean by "expensive".
//   balanced:  rank-sum of cost rank and latency rank. Rank-sum rather than
//              cost*latency so a single outlier on one axis cannot dominate.
//   compliant: the zdr row, and only the zdr row. If it errored, say so; never
//              fall back to a non-ZDR endpoint for a customer who asked for ZDR.
//
// cache+sticky is represented by its warm call (call 2), because the cold call
// is a one-time cost and the warm call is what the customer pays 100 times.
export function recommend(rows: Row[], goal: Goal): Recommendation | null {
  const s = scored(rows).filter((r) => !(r.name === "cache+sticky" && r.call === 1) && r.name !== "free" && !Number.isNaN(r.cost));
  if (s.length === 0) return null;

  if (goal === "compliant") {
    const z = s.find((r) => r.zdr);
    return z
      ? { strategy: z.name, reason: `only Zero-Data-Retention endpoints; served by ${z.provider} at $${z.cost.toFixed(5)}, ${z.latencyMs}ms` }
      : { strategy: "zdr", reason: "the zdr row did not return; no non-ZDR fallback is acceptable for this goal, fix the provider pool first" };
  }

  const byCost = [...s].sort((a, b) => a.cost - b.cost || a.latencyMs - b.latencyMs);
  if (goal === "cheapest") {
    const w = byCost[0]!;
    return { strategy: w.name, reason: `$${w.cost.toFixed(5)} on ${w.provider} (${w.model}), ${w.latencyMs}ms; cached ${w.cached} tokens` };
  }

  const median = byCost[Math.floor(byCost.length / 2)]!.cost;
  if (goal === "fastest") {
    const eligible = s.filter((r) => r.cost <= 2 * median).sort((a, b) => a.latencyMs - b.latencyMs);
    const w = eligible[0] ?? byCost[0]!;
    return { strategy: w.name, reason: `${w.latencyMs}ms on ${w.provider} at $${w.cost.toFixed(5)} (within 2x the median cost of $${median.toFixed(5)})` };
  }

  // balanced
  const byLat = [...s].sort((a, b) => a.latencyMs - b.latencyMs);
  const score = new Map<string, number>();
  s.forEach((r) => score.set(r.name, byCost.findIndex((x) => x.name === r.name) + byLat.findIndex((x) => x.name === r.name)));
  const w = [...s].sort((a, b) => score.get(a.name)! - score.get(b.name)!)[0]!;
  return { strategy: w.name, reason: `best cost+latency rank-sum: $${w.cost.toFixed(5)}, ${w.latencyMs}ms on ${w.provider}` };
}
