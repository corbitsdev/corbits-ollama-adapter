# @corbits/ollama-adapter

A custom Interchange inference adapter for the `ollama` provider key
(Ollama's `openai-compatible` endpoint, `/v1`). It wraps the built-in
OpenAI Chat Completions adapter — reusing its message marshaling, SSE
parsing, and retry/pacing header extraction unchanged — and adds one
thing: operator-configured overrides for context window, max output
tokens, and reasoning effort, applied to every built request body.

## Why

Ollama's `/v1/chat/completions` endpoint has no OpenAI-shaped field for
context window (`num_ctx`); it only takes it through the endpoint's
`options` passthrough object, exactly like the native `/api/chat`
surface. Without a custom adapter, `num_ctx` has nowhere to go and is
silently ignored. `max_tokens` (mapped internally to Ollama's
`num_predict`) and `reasoning_effort` (recognized for `gpt-oss` models)
both ride through fields the built-in adapter already sets, so this
adapter just lets an operator override them.

## Activating it

Set the sidecar's `SIDECAR_ADAPTER_MANIFEST` env var to a JSON array
naming this package for the `ollama` provider key:

```
SIDECAR_ADAPTER_MANIFEST=[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAdapter"}]
```

`@corbits/ollama-adapter` must be installed in the sidecar's workspace —
the manifest names an already-installed module, it never carries code of
its own. See the root `.env.example` for the full `SIDECAR_ADAPTER_MANIFEST`
contract.

## Configuring overrides

Overrides ride in as the adapter's `quirks` argument, which
`loadAdapterRegistry` resolves from the matching `InferenceSource.quirks`
bag (the per-catalog-entry config an operator sets on a connected
provider's model). The shape:

```jsonc
{
  // Applies to every model resolved through this source unless a
  // perModel entry below overrides a field.
  "default": {
    "numCtx": 8192,
    "maxOutputTokens": 4096,
    "reasoningEffort": "medium",
  },
  "perModel": {
    "gpt-oss:20b": { "numCtx": 32768, "reasoningEffort": "high" },
  },
}
```

- `numCtx` — positive integer, sets `options.num_ctx` on the request body.
- `maxOutputTokens` — positive integer, overrides whichever max-tokens
  field the built-in adapter set (`max_tokens` or `max_completion_tokens`).
- `reasoningEffort` — `"low" | "medium" | "high"`, sets `reasoning_effort`.

A per-model entry wins field-by-field over `default`; an unconfigured
field falls through to the built-in adapter's own behavior (no override).
With no `quirks` at all, the built request body is byte-for-byte
equivalent to the built-in OpenAI adapter's.

## Spike: the stock Anthropic adapter against Ollama's `/v1/messages`

Ollama serves an Anthropic-compatible endpoint
(`docs.ollama.com/api/anthropic-compatibility.md`) at local
`:11434/v1/messages` and cloud `https://ollama.com/v1/messages`.
`src/anthropic-ollama.spike.test.ts` drives `@intx/inference`'s stock,
unmodified `createAnthropicAdapter` straight at a local Ollama — no code
from this package is in the request/response path — covering a plain chat
turn, a streaming turn, a tool-call turn, and a thinking turn. It skips
cleanly when Ollama is unreachable, the model is missing, or
`/v1/messages` is 404.

### Findings

- **Chat, streaming, tool calls, thinking all work over the stock
  adapter**, against `gpt-oss:20b`. Streamed SSE arrives in Anthropic's
  native `content_block_start` / `content_block_delta` shape, including a
  native `thinking` content block with real `thinking_delta` events —
  Ollama emits genuine reasoning as a structured block on this endpoint,
  not the inline `<think>` tags it emits on the OpenAI-compatible
  endpoint. **No think-tag stripping is needed on this path at all.**
  Native tool calls arrive as real `tool_use` blocks with
  `input_json_delta` argument streaming — no inline-JSON salvage is
  needed either.
- **`tool_choice` and prompt-caching's `cache_control` are accepted but
  inert.** A request carrying `tool_choice: {"type":"auto"}` and
  `cache_control: {"type":"ephemeral"}` on both `system` and a message
  block returns 200 with no error, but the response's
  `cache_read_input_tokens` is always `0` — Ollama does not implement
  prompt caching, it just doesn't reject the field. Whether Ollama honors
  a non-`auto` `tool_choice` (forcing a specific tool, or disabling tools)
  was not exercised here and needs a dedicated check before CL-8357 leans
  on "accepted" meaning "works."
- **Batches and PDF (`document`) blocks are unexercised** — this spike
  only covers the four required turns; Ollama's Anthropic-compatible
  surface documents no batches endpoint at all, and PDF/document block
  support is untested here.
- **`num_ctx` has no home on this path.** The Anthropic Messages protocol
  has no context-window field and no passthrough `options` bag the way
  Ollama's native `/api/chat` and OpenAI-compatible `/v1/chat/completions`
  both expose; the stock Anthropic adapter's `buildRequest` builds a fixed
  set of top-level keys with nowhere to add one. Setting `num_ctx` against
  this endpoint is only possible via `OLLAMA_CONTEXT_LENGTH` at the Ollama
  server level (a deployment-wide default, not a per-request override), or
  by not switching this adapter over.

### Decision: replace

Chat, streaming, tool calls, and thinking all work correctly through the
unmodified stock Anthropic adapter, with better fidelity than the current
custom adapter's OpenAI-compat workarounds (native thinking blocks instead
of tag-stripped text, native tool_use instead of inline-JSON salvage). The
decision is to **replace this package's custom OpenAI-compat wrapper with
a thin preset over the stock Anthropic adapter** for the `ollama` provider
key. The one capability the OpenAI-compat path had that the Anthropic
path does not is `num_ctx` — that override has no wire location on
`/v1/messages`, so a from-here adapter can carry `maxOutputTokens` and
`reasoningEffort` overrides but not `numCtx`; operators needing a specific
context window must set `OLLAMA_CONTEXT_LENGTH` on the server. This
narrows what CL-8355 through CL-8359 need to do, and each of their PRs
notes what still applies given the stock adapter's own behavior.
