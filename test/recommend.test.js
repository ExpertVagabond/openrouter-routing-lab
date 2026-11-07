import test from "node:test";
import assert from "node:assert/strict";

import { recommend, scored } from "../src/recommend.ts";

function row(name, cost, latencyMs, options = {}) {
  return {
    strategy: {
      name,
      lever: options.lever ?? "test",
      why: "test fixture",
      build: async () => ({ model: "test/model", messages: [] }),
    },
    call: options.call ?? 1,
    result: {
      id: `result-${name}`,
      model: options.model ?? "test/model",
      provider: options.provider ?? "Test Provider",
      text: "{}",
      finishReason: "stop",
      latencyMs,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost,
        prompt_tokens_details: { cached_tokens: options.cached ?? 0 },
      },
      raw: {},
    },
  };
}

test("scored ignores rows that did not produce a result", () => {
  const failed = {
    strategy: { name: "failed", lever: "test", why: "test", build: async () => ({}) },
    call: 1,
    error: "provider unavailable",
  };
  assert.deepEqual(scored([failed]), []);
});

test("cheapest selects the lowest-cost usable strategy", () => {
  const result = recommend([
    row("default", 0.004, 200),
    row("sort:price", 0.001, 500),
  ], "cheapest");
  assert.equal(result?.strategy, "sort:price");
});

test("cheapest breaks equal-cost ties by latency", () => {
  const result = recommend([
    row("slow", 0.001, 600),
    row("fast", 0.001, 100),
  ], "cheapest");
  assert.equal(result?.strategy, "fast");
});

test("free rows never become a production recommendation", () => {
  const result = recommend([
    row("free", 0, 25),
    row("paid", 0.001, 100),
  ], "cheapest");
  assert.equal(result?.strategy, "paid");
});

test("cache strategy is evaluated on its warm call", () => {
  const result = recommend([
    row("cache+sticky", 0.02, 900, { call: 1 }),
    row("cache+sticky", 0.0005, 200, { call: 2, cached: 2500 }),
    row("default", 0.001, 150),
  ], "cheapest");
  assert.equal(result?.strategy, "cache+sticky");
  assert.match(result?.reason ?? "", /cached 2500 tokens/);
});

test("fastest rejects an extreme cost outlier", () => {
  const result = recommend([
    row("reasonable", 0.002, 300),
    row("median", 0.003, 400),
    row("expensive", 0.1, 20),
  ], "fastest");
  assert.equal(result?.strategy, "reasonable");
});

test("compliant selects only the ZDR strategy", () => {
  const result = recommend([
    row("default", 0.0001, 50),
    row("zdr", 0.004, 500),
  ], "compliant");
  assert.equal(result?.strategy, "zdr");
});

test("compliant fails closed when no ZDR result exists", () => {
  const result = recommend([row("default", 0.0001, 50)], "compliant");
  assert.equal(result?.strategy, "zdr");
  assert.match(result?.reason ?? "", /no non-ZDR fallback is acceptable/);
});

test("returns null when there are no usable priced results", () => {
  const missingCost = row("unknown", undefined, 100);
  assert.equal(recommend([missingCost], "balanced"), null);
});
