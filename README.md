# @corbits/ollama-adapter

A custom Interchange inference adapter for the `ollama` provider key.
Ollama documents two HTTP surfaces as first-class, and this package
exports a factory for each:

- **OpenAI-compat** `POST /v1/chat/completions` (local
  `http://localhost:11434/v1/chat/completions`, cloud
  `https://ollama.com/v1/chat/completions`) —
  [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).
  `createOllamaAdapter` wraps Interchange's built-in OpenAI Chat
  Completions adapter against this surface.
- **Anthropic** `POST /v1/messages` (local
  `http://localhost:11434/v1/messages`, cloud
  `https://ollama.com/v1/messages`) —
  [Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility).
  `createOllamaAnthropicAdapter` wraps Interchange's stock
  `createAnthropicAdapter` against this surface. Workbench catalog and
  Cloud sources already use a `/v1` base, so the factory emits
  `/messages` (the harness concatenates `baseURL + path`) and
  `Authorization: Bearer` rather than stock Anthropic `/v1/messages`
  plus `x-api-key`.

Neither surface replaces the other. OpenAI-compat is where per-request
`num_ctx` and this adapter's think-tag / inline-tool-JSON repairs live.
Anthropic is where Ollama emits native `thinking` and `tool_use` blocks.
Pick the surface that matches the model and the fields you need. A
sidecar manifest can name either export.

## Why the OpenAI-compat wrapper exists

Ollama's `/v1/chat/completions` endpoint has no OpenAI-shaped field for
context window (`num_ctx`); it only takes it through the endpoint's
`options` passthrough object, exactly like the native `/api/chat`
surface. Without a custom adapter, `num_ctx` has nowhere to go and is
silently ignored. `max_tokens` (mapped internally to Ollama's
`num_predict`) and `reasoning_effort` (recognized for `gpt-oss` models)
both ride through fields the built-in adapter already sets, so this
adapter just lets an operator override them.

The wrapper reuses the built-in OpenAI adapter's message marshaling, SSE
parsing, and retry/pacing header extraction unchanged, then applies
operator-configured overrides to every built request body.

## Activating it

Set the sidecar's `SIDECAR_ADAPTER_MANIFEST` env var to a JSON array
naming this package for the `ollama` provider key. OpenAI-compat:

```
SIDECAR_ADAPTER_MANIFEST=[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAdapter"}]
```

Anthropic `/v1/messages`:

```
SIDECAR_ADAPTER_MANIFEST=[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAnthropicAdapter"}]
```

`@corbits/ollama-adapter` must be installed in the sidecar's workspace —
the manifest names an already-installed module, it never carries code of
its own. See the root `.env.example` for the full `SIDECAR_ADAPTER_MANIFEST`
contract.

## Configuring overrides

Overrides ride in as the adapter's `quirks` argument, which
`loadAdapterRegistry` resolves from the matching `InferenceSource.quirks`
bag (the per-catalog-entry config an operator sets on a connected
provider's model). They apply to `createOllamaAdapter` (OpenAI-compat).
`createOllamaAnthropicAdapter` parses the same bag so a shared sidecar
config does not fail validation, then ignores the values — Anthropic
`/v1/messages` has no `num_ctx` / `think` overlay. The shape:

```jsonc
{
  // Applies to every model resolved through this source unless a
  // perModel entry below overrides a field.
  "default": {
    "numCtx": 8192,
    "maxOutputTokens": 4096,
    "reasoningEffort": "medium",
    "think": "medium",
  },
  "perModel": {
    "gpt-oss:20b": { "numCtx": 32768, "reasoningEffort": "high" },
  },
}
```

- `numCtx` — positive integer, sets `options.num_ctx` on the request body.
  OpenAI-compat only; Anthropic `/v1/messages` has no context-window field.
- `maxOutputTokens` — positive integer, overrides whichever max-tokens
  field the built-in adapter set (`max_tokens` or `max_completion_tokens`).
- `reasoningEffort` — `"low" | "medium" | "high"`, sets `reasoning_effort`.
- `think` — `boolean | "low" | "medium" | "high" | "max"`, sets `think` so a
  thinking-capable model returns its reasoning in the response's native
  `message.reasoning` field instead of inline `<think>…</think>` tags in
  `content`. Most models accept a boolean or those levels (`max` is the
  highest). gpt-oss only honors `"low" | "medium" | "high"`; a boolean
  `think: false` is ignored and does not disable the trace. Verified
  directly against a local Ollama on the OpenAI-compatible endpoint:
  `think` set to `"high"` produces a `reasoning` field with no `<think>`
  tags anywhere in `content`.

A per-model entry wins field-by-field over `default`; an unconfigured
field falls through to the built-in adapter's own behavior (no override).
With no `quirks` at all, the built request body is byte-for-byte
equivalent to the built-in OpenAI adapter's.

## Images must be base64

Ollama's OpenAI-compatible endpoint only accepts a base64 `data:`
`image_url` — it does not fetch a public URL the way OpenAI itself does.
The built-in adapter's `url`-kind `MediaSource` support passes a public
URL straight through, which Ollama does not fetch. `createOllamaAdapter`'s
`buildRequest` rejects any non-base64 image source (a public URL or a
file reference) with an error naming the offending source before the
request is sent; a base64 image part passes through unchanged.

## Ollama Cloud

This adapter works unchanged against Ollama Cloud — it is the same
OpenAI-compatible (or Anthropic-compatible) surface, just a different
base URL and auth scheme. An `InferenceSource` pointed at Ollama Cloud
instead of a local install needs:

- **Base URL**: `https://ollama.com/v1` (same as local catalog
  `http://localhost:11434/v1`). `createOllamaAdapter` concatenates
  `/chat/completions`; `createOllamaAnthropicAdapter` concatenates
  `/messages`. Native `https://ollama.com/api/` is a different surface
  and would miss those `/v1` paths.
- **Auth**: `Authorization: Bearer <key>` on both factories (the bearer
  credential sentinel), with the key generated at
  [ollama.com/settings/keys](https://ollama.com/settings/keys)
- **Models**: the cloud-hosted catalog is listed at
  [ollama.com/search?c=cloud](https://ollama.com/search?c=cloud) — it is
  not the same set as whatever is pulled on a local install

Pricing and rate limits for Ollama Cloud are not documented anywhere in
`docs.ollama.com`, so this package ships no default cloud source and no
built-in cost/limit assumptions for it; an operator wiring one up sets
the base URL, bearer key, and model name explicitly with no
Ollama-Cloud-specific config from this adapter.

## Spike: `createOllamaAnthropicAdapter` against Ollama's `/v1/messages`

Ollama serves an Anthropic-compatible endpoint
(`docs.ollama.com/api/anthropic-compatibility.md`) at local
`:11434/v1/messages` and cloud `https://ollama.com/v1/messages`.
`src/anthropic-ollama.spike.test.ts` drives `createOllamaAnthropicAdapter`
at a local Ollama using the workbench `/v1` source base, covering a
plain chat turn, a streaming turn, a tool-call turn, and a thinking
turn. It skips cleanly when Ollama is unreachable, the model is missing,
or `/v1/messages` is 404.

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
  was not exercised here.
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
  server level (a deployment-wide default, not a per-request override).
  Per-request `num_ctx` stays on the OpenAI-compat wrapper.

### Decision: support both

Chat, streaming, tool calls, and thinking all work through the unmodified
stock Anthropic adapter, with native thinking blocks and native `tool_use`
on `/v1/messages`. That does **not** retire this package's OpenAI-compat
wrapper. Ollama documents both surfaces; operators who need per-request
`num_ctx`, think-tag stripping, or inline-tool-JSON salvage stay on
`/v1/chat/completions` via `createOllamaAdapter`. Operators who want
Anthropic-shaped thinking and tool_use stay on `/v1/messages` via
`createOllamaAnthropicAdapter`.
