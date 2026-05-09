// Optional enrichment stage for unreal_search_project results.
//
// If UNREAL_MCP_LOCAL_LLM_URL is set, this calls an OpenAI-compatible chat-completions
// endpoint (works out of the box with Ollama's `ollama serve` -> http://localhost:11434/v1,
// LM Studio, vLLM's OpenAI-compatible server, etc) to generate a short one-line
// natural-language summary per search hit, e.g. turning a bare hit like
// `{ kind: "function", name: "TakeDamage", context: "function in BP_Enemy" }` into one
// that also carries `summary: "Reduces health and triggers death when it hits zero"`.
//
// If UNREAL_MCP_LOCAL_LLM_URL is NOT set (the default), every exported function here is
// a pure pass-through: zero network calls, zero latency added, zero setup required. This
// is a deliberate design choice from the M3 brief. The point is to let cheap/mechanical
// summarization be offloaded to a small local/free model instead of spending the calling
// model's (Claude's) own tokens on it, without that ever being a requirement to use
// unreal_search_project at all.
//
// Best-effort only: any failure (unreachable endpoint, timeout, malformed response) for
// an individual hit silently falls back to returning that hit without a summary. A
// misconfigured or offline local model must never break search results.

import type { SearchHit } from "./types.js";

const LOCAL_LLM_URL = process.env.UNREAL_MCP_LOCAL_LLM_URL;
const LOCAL_LLM_MODEL = process.env.UNREAL_MCP_LOCAL_LLM_MODEL ?? "llama3.2";
const ENRICH_TIMEOUT_MS = Number(process.env.UNREAL_MCP_LOCAL_LLM_TIMEOUT_MS ?? 4000);
// Caps how many hits get a live enrichment call per search, so one big result set can't
// turn into dozens of local-model round trips on a single tool call.
const MAX_ENRICH_PER_CALL = Number(process.env.UNREAL_MCP_LOCAL_LLM_MAX_PER_CALL ?? 8);

export function isEnrichmentEnabled(): boolean {
  return Boolean(LOCAL_LLM_URL);
}

// In-memory, per-process cache keyed by the hit's own structural content (kind + path +
// name + context), so repeated searches don't re-call the local model for the same item,
// and the cache naturally "invalidates" if the underlying structure changes shape (a
// changed context string produces a different key). This is intentionally simple:
// process-lifetime only, not persisted to disk. See docs/M3_STATUS.md for the rationale
// and what a follow-up on-disk cache would look like.
const summaryCache = new Map<string, string>();

function cacheKey(hit: SearchHit): string {
  return `${hit.kind}:${hit.path}:${hit.name}:${hit.context}`;
}

async function requestSummary(hit: SearchHit): Promise<string | undefined> {
  if (!LOCAL_LLM_URL) {
    return undefined;
  }

  const prompt =
    `In one short sentence (under 15 words), describe what this Unreal Engine Blueprint ${hit.kind} probably does, ` +
    `based only on its name and context. Do not just restate the name; infer intent. Reply with the sentence only, ` +
    `no preamble.\n` +
    `kind: ${hit.kind}\nname: ${hit.name}\ncontext: ${hit.context}\npath: ${hit.path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS);

  try {
    const base = LOCAL_LLM_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_LLM_MODEL,
