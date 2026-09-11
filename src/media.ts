// Media through the same key: one image out, one audio in.
//
//   node --env-file-if-exists=$HOME/.config/openrouter/openrouter.env src/media.ts image "prompt"
//   node --env-file-if-exists=$HOME/.config/openrouter/openrouter.env src/media.ts transcribe path/to.wav
//
// Image generation uses POST /images (not chat completions); transcription is a
// normal chat completion with an `input_audio` content part. Both report
// `usage.cost` so they land in the same Activity accounting as text.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { OpenRouterError } from "./openrouter.ts";

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not set");
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

// Priced per output-image token on Gemini (~1,290 tokens/image → ~$0.04 at the
// default tier). Seedream 5.0 Lite is a flat $0.035/image if you prefer a fixed price.
export const IMAGE_MODEL = "google/gemini-2.5-flash-image";
// Audio is ~32 tokens per second; Flash-Lite bills $0.30/M audio tokens → ~$0.035/hour.
export const TRANSCRIBE_MODEL = "google/gemini-2.5-flash-lite";

export async function image(prompt: string) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/images`, { method: "POST", headers, body: JSON.stringify({ model: IMAGE_MODEL, prompt }) });
  if (!res.ok) throw new OpenRouterError(res.status, await res.text());
  const data = (await res.json()) as any;
  const first = data.data?.[0];
  if (!first?.b64_json) throw new Error(`no image in response: ${JSON.stringify(data).slice(0, 300)}`);
  mkdirSync("results", { recursive: true });
  const ext = (first.media_type ?? "image/png").split("/")[1];
  const file = `results/image-${Date.now()}.${ext}`;
  writeFileSync(file, Buffer.from(first.b64_json, "base64"));
  return { file, bytes: Buffer.byteLength(first.b64_json, "base64"), latencyMs: Math.round(performance.now() - t0), usage: data.usage };
}

export async function transcribe(path: string) {
  const format = path.split(".").pop()!.toLowerCase();
  const b64 = readFileSync(path).toString("base64");
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: TRANSCRIBE_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this audio verbatim. Output only the transcript." },
            { type: "input_audio", input_audio: { data: b64, format } },
          ],
        },
      ],
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new OpenRouterError(res.status, await res.text());
  const data = (await res.json()) as any;
  return { text: data.choices?.[0]?.message?.content ?? "", provider: data.provider, latencyMs: Math.round(performance.now() - t0), usage: data.usage };
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "image") {
  const r = await image(arg ?? "a red panda astronaut floating in space, studio lighting");
  console.log(`image -> ${r.file} (${r.bytes} bytes) ${r.latencyMs}ms cost=$${r.usage?.cost ?? "?"}`);
} else if (cmd === "transcribe") {
  if (!arg) throw new Error("transcribe needs a file path");
  const r = await transcribe(arg);
  console.log(`transcript via ${r.provider} ${r.latencyMs}ms cost=$${r.usage?.cost ?? "?"} audio_tokens=${r.usage?.prompt_tokens_details?.audio_tokens ?? "?"}`);
  console.log(r.text);
} else {
  console.error("usage: media.ts image <prompt> | transcribe <file>");
  process.exit(1);
}
