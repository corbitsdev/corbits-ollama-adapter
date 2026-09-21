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

## Parameters Ollama silently drops

Ollama's OpenAI-compatible endpoint accepts `tool_choice`, `logit_bias`,
`user`, and `n` on the wire without error, but does not apply any of them
— confirmed directly against a local Ollama: a bogus `tool_choice`, a
`logit_bias` entry, a `user` field, and `n: 3` all return a normal 200
with exactly one choice, no error, no effect. A caller relying on any of
these would silently get different behavior than requested with nothing
to signal it. `buildRequest` rejects a `providerOptions` bag carrying any
of these four keys with an error naming the parameter, rather than let
the request through as a silent no-op. Other leftover `providerOptions`
keys are not forwarded either: Interchange's OpenAI `buildRequest` never
merges `providerOptions` into the body, so they never land on the wire.
