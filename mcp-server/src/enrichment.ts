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
