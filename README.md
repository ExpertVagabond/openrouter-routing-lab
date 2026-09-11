# openrouter-routing-lab

One workload, every OpenRouter routing lever, one table.

The question a customer asks after their first week on OpenRouter is "which of these knobs should I actually set?" This repo answers it with measurements instead of adjectives: it sends the same support-triage prompt through each strategy in `src/strategies.ts` and prints which provider served, which model ran, latency, tokens, cached tokens, and cost, straight from the response.

```
strategy          call  provider        model                               ms      in     out   cached  cost       finish
default           1     DeepInfra       deepseek/deepseek-chat-v3.1         916     571    77    4       $0.00022   stop
sort:price        1     DeepInfra       deepseek/deepseek-chat-v3.1         257     571    82    570     $0.00015   stop
sort:latency      1     DeepInfra       deepseek/deepseek-chat-v3.1         300     571    80    570     $0.00015   stop
order+fallbacks   1     DeepInfra       deepseek/deepseek-chat-v3.1         251     571    82    570     $0.00015   stop
zdr               1     DeepInfra       deepseek/deepseek-chat-v3.1         203     571    82    570     $0.00015   stop
:floor            1     DeepInfra       deepseek/deepseek-chat-v3.1         262     571    78    570     $0.00015   stop
:nitro            1     CoreWeave       deepseek/deepseek-chat-v3.1         905     572    83    0       $0.00045   stop
model-fallbacks   1     Amazon Bedrock  anthropic/claude-haiku-4.5          879     607    125   0       $0.00123   stop
auto:low          1     Google AI Stud  google/gemini-3.8-flash             4809    588    801   0       $0.00344   stop
auto:high         1     OpenAI          openai/gpt-5.6-sol                  914     565    196   0       $0.00309   stop
cache+sticky      1     Claude Platfor  anthropic/claude-sonnet-4.6         997     2579   141   2501    $0.00310   stop
cache+sticky      2     Claude Platfor  anthropic/claude-sonnet-4.6         905     2579   131   2501    $0.00295   stop
```

Real run, 2026-09-11, 12 calls, $0.0165 total. (The cache row shows a hit on call 1 because a run five minutes earlier had already written the cache; the cold call in that earlier run was $0.01158, so the warm read is a 74% cut.)

## What the run taught

These came out of the first three runs and are the findings a customer would have hit alone.

1. **Implicit caching on DeepInfra kicked in with zero client configuration.** Every DeepSeek row that landed on DeepInfra after the first shows `cached=570` and cost down from $0.00022 to $0.00015 (−32%). `default` load-balanced away from it once and paid full price. That is the sticky-routing argument in one column.
2. **`cache_control` is silently ignored below the model's minimum prefix.** Anthropic caches from 1,024 tokens on Sonnet 4.6 but **4,096 on Haiku 4.5 and Opus 4.x**. A 2,578-token prompt on Haiku wrote nothing (`cache_write_tokens: 0`, no error). Same prompt on Sonnet: 2,501 cached, $0.01158 → $0.00305.
3. **Reasoning models spend `max_tokens` on thinking first.** `auto:low` picked `gemini-3.8-flash`, which used 289 reasoning tokens of a 300 budget and returned a fragment with `finish_reason: length`. Headroom fixed it; the `finish` column now makes it visible.
4. **Models fence JSON even when told not to.** Claude wrapped the object in a code fence despite rule 5. Strip fences or use `response_format`; do not count it as a model failure.
5. **Temperature 0 is not determinism.** DeepSeek V3.1 on the same DeepInfra fp4 endpoint returned P0 on two rows and P1 on four for an identical request. Sonnet with the runbook returned P0 both times because runbook §1.1 removes the ambiguity. Fix the prompt before blaming the model, and do not sell a customer "temperature 0" as reproducibility.
7. **`models` fallback covers request failures, not bad completions.** `nvidia/nemotron-3.5-lightning:free` returned HTTP 200 with `finish_reason: error`, empty content, and 816 reasoning tokens; no fallback fired. When `thinkingmachines/inkling:free` failed at the request level, the list fell through to `poolside/laguna-s-2.1:free` for $0. If a customer needs "retry on garbage", that is client-side logic on `finish_reason`, not `models`.
6. **`auto:low` was the slowest and among the most expensive rows here.** Community spend share picked a reasoning model for a short classification task. The Auto Router is for the long tail, not for a workload you have already characterised.

## Run

Node 22.6+ (runs `.ts` directly, no build step). One dev dependency for `tsc --noEmit`.

```sh
# key in ~/.config/openrouter/openrouter.env as OPENROUTER_API_KEY=sk-or-v1-...
npm install
npm run lab                      # every strategy
npm run lab -- default zdr       # a subset by name
npm run lab -- --goal cheapest   # plus a recommendation (rule lives in src/recommend.ts)
```

Every run writes `results/<timestamp>.json` with response ids, so any number in the table can be traced back.

## What each row demonstrates

| Row | Lever | Reach for it when |
|---|---|---|
| `default` | none | Baseline. Load-balanced by inverse square of price; providers with an outage in the last 30s are skipped. |
| `sort:price` / `:floor` | `provider.sort` | Batch and offline work. Note that setting `sort` or `order` turns load balancing off. |
| `sort:latency` / `:nitro` | `provider.sort` | Interactive product surfaces. |
| `order+fallbacks` | `provider.order`, `allow_fallbacks` | Contractual or quality preference for named providers, without going down when they do. |
| `zdr` | `provider.zdr`, `data_collection` | Regulated data. Smaller pool, so pair with `models` fallbacks. |
| `model-fallbacks` | `models` | Survive a model-level outage, not only a provider one. |
| `auto:*` | `openrouter/auto` + `plugins[{id:"auto-router", cost_tier}]` | Long-tail tasks where nobody wants to maintain a model matrix. |
| `cache+sticky` | `cache_control`, constant `user` | Long fixed prefix, many turns. The second call is the point. |
| `free` | `:free` suffix + `models` | Smoke tests and CI at $0. Rate-limited; some endpoints train on prompts. |

## Files

- `src/openrouter.ts` — fetch-only client; the fields an FDE points at (`provider`, `model`, `usage.cost`, `usage.prompt_tokens_details.cached_tokens`), plus `/endpoints` for live per-provider pricing and uptime.
- `src/strategies.ts` — the workload and the strategy list. Add a row by adding an object.
- `src/runbook.ts` — the long system-prompt appendix that gets the cache row over Anthropic's minimum prefix.
- `src/recommend.ts` — turns rows into "ship this one" for a goal (`cheapest | fastest | balanced | compliant`).
- `src/index.ts` — runner, table, results dump, output-validity check.

## References

- Provider routing: https://openrouter.ai/docs/features/provider-routing
- Auto Router: https://openrouter.ai/blog/announcements/introducing-the-new-auto-router/
- Prompt caching and sticky routing: https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/
- In-region routing: https://openrouter.ai/blog/announcements/us-in-region-routing/
