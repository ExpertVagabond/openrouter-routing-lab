// openrouter-routing-lab
//
// Runs one fixed workload through every routing strategy in strategies.ts and
// prints a comparison table, then writes the raw responses to results/ so the
// numbers can be checked. Usage:
//
//   npm run lab                     # all strategies
//   npm run lab -- default zdr      # a subset, by name
//   npm run lab -- --goal cheapest  # also print a recommendation (see recommend.ts)

import { mkdirSync, writeFileSync } from "node:fs";
import { strategies, runStrategy, type Row } from "./strategies.ts";
import { recommend, type Goal } from "./recommend.ts";

const argv = process.argv.slice(2);
const goalIdx = argv.indexOf("--goal");
const goal = goalIdx >= 0 ? (argv[goalIdx + 1] as Goal) : undefined;
const names = argv.filter((a, i) => !a.startsWith("--") && (goalIdx < 0 || i !== goalIdx + 1));
const selected = names.length ? strategies.filter((s) => names.includes(s.name)) : strategies;

if (selected.length === 0) {
  console.error(`No strategy matched. Known: ${strategies.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

const money = (n: number | undefined) => (n == null || Number.isNaN(n) ? "     ?" : `$${n.toFixed(5)}`);
const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);

const rows: Row[] = [];
console.log(`\nworkload: support-triage ticket, ${selected.length} strategies\n`);
console.log(
  [pad("strategy", 16), pad("call", 4), pad("provider", 14), pad("model", 34), pad("ms", 6), pad("in", 5), pad("out", 4), pad("cached", 6), "cost"].join("  "),
);

for (const s of selected) {
  const out = await runStrategy(s);
  for (const r of out) {
    rows.push(r);
    if (r.result) {
      const u = r.result.usage;
      console.log(
        [
          pad(s.name, 16),
          pad(String(r.call), 4),
          pad(r.result.provider, 14),
          pad(r.result.model, 34),
          pad(String(r.result.latencyMs), 6),
          pad(String(u.prompt_tokens), 5),
          pad(String(u.completion_tokens), 4),
          pad(String(u.prompt_tokens_details?.cached_tokens ?? 0), 6),
          money(u.cost),
        ].join("  "),
      );
    } else {
      console.log([pad(s.name, 16), pad(String(r.call), 4), `ERROR ${r.error}`].join("  "));
    }
  }
}

// Persist everything so a number in the table can be traced to a response id.
mkdirSync("results", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `results/${stamp}.json`;
writeFileSync(
  file,
  JSON.stringify(
    rows.map((r) => ({
      strategy: r.strategy.name,
      lever: r.strategy.lever,
      call: r.call,
      error: r.error,
      id: r.result?.id,
      provider: r.result?.provider,
      model: r.result?.model,
      latencyMs: r.result?.latencyMs,
      usage: r.result?.usage,
      text: r.result?.text,
    })),
    null,
    2,
  ),
);
console.log(`\nraw responses: ${file}`);

// Sanity check that the triage output is actually usable, not just cheap.
const parsed = rows.filter((r) => r.result).map((r) => {
  try {
    const j = JSON.parse(r.result!.text);
    return { name: r.strategy.name, call: r.call, ok: typeof j.category === "string" && typeof j.severity === "string", severity: j.severity, category: j.category };
  } catch {
    return { name: r.strategy.name, call: r.call, ok: false };
  }
});
const bad = parsed.filter((p) => !p.ok);
console.log(`\noutput validity: ${parsed.length - bad.length}/${parsed.length} returned parseable triage JSON${bad.length ? ` (failed: ${bad.map((b) => `${b.name}#${b.call}`).join(", ")})` : ""}`);
const sev = new Map<string, number>();
for (const p of parsed) if (p.ok) sev.set(`${p.severity}/${p.category}`, (sev.get(`${p.severity}/${p.category}`) ?? 0) + 1);
console.log(`severity/category votes: ${[...sev.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);

if (goal) {
  const rec = recommend(rows, goal);
  console.log(rec ? `\nrecommend for "${goal}": ${rec.strategy} — ${rec.reason}` : `\nrecommend for "${goal}": no rule implemented yet (see src/recommend.ts)`);
}
