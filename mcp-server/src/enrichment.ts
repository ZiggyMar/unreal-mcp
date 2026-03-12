// Optional enrichment stage for unreal_search_project results.
//
// If UNREAL_MCP_LOCAL_LLM_URL is set, this calls an OpenAI-compatible chat-completions
// endpoint (works out of the box with Ollama's `ollama serve` -> http://localhost:11434/v1,
// LM Studio, vLLM's OpenAI-compatible server, etc) to generate a short one-line
// natural-language summary per search hit, e.g. turning a bare hit like
