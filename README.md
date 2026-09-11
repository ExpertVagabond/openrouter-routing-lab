# openrouter-routing-lab

One workload, every OpenRouter routing lever, one table.

The question a customer asks after their first week on OpenRouter is "which of these knobs should I actually set?" This repo answers it with measurements instead of adjectives: it sends the same support-triage prompt through each strategy in `src/strategies.ts` and prints which provider served, which model ran, latency, tokens, cached tokens, and cost, straight from the response.

```
strategy          call  provider        model                               ms      in     out   cached  cost
default           1     DeepInfra       deepseek/deepseek-chat-v3.1         ...
sort:price        1     ...
sort:latency      1     ...
order+fallbacks   1     ...   # provider.order derived live from /models/:id/endpoints
zdr               1     ...   # only zero-data-retention endpoints
:floor            1     ...
:nitro            1     ...
model-fallbacks   1     ...   # models: [...] — `model` column shows which one answered
auto:low          1     ...   # openrouter/auto, cost_tier=low — `model` column shows the pick
auto:high         1     ...
cache+sticky      1     ...   # cold
cache+sticky      2     ...   # warm: cached > 0, cost down
```

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

## Files

- `src/openrouter.ts` — fetch-only client; the fields an FDE points at (`provider`, `model`, `usage.cost`, `usage.prompt_tokens_details.cached_tokens`), plus `/endpoints` for live per-provider pricing and uptime.
- `src/strategies.ts` — the workload and the strategy list. Add a row by adding an object.
- `src/recommend.ts` — turns rows into "ship this one" for a goal (`cheapest | fastest | balanced | compliant`).
- `src/index.ts` — runner, table, results dump, output-validity check.

## References

- Provider routing: https://openrouter.ai/docs/features/provider-routing
- Auto Router: https://openrouter.ai/blog/announcements/introducing-the-new-auto-router/
- Prompt caching and sticky routing: https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/
- In-region routing: https://openrouter.ai/blog/announcements/us-in-region-routing/
