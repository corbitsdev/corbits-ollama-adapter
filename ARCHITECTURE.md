# @corbits/ollama-adapter — Architecture

Two `AdapterFactory` components wrap Interchange's stock OpenAI and Anthropic adapters against Ollama's two HTTP surfaces. The package is a thin overlay: request/response parsing stays in Interchange; this library owns the Ollama-specific gates, overlays, and repairs.

```
SIDECAR_ADAPTER_MANIFEST
        │  names one export on provider "ollama"
        ▼
loadAdapterRegistry
        │  one factory per request
        ▼
┌───────────────────────────────────────────────────────────┐
│  createOllamaAdapter            createOllamaAnthropicAdapter
│  wrap createOpenAIAdapter       wrap createAnthropicAdapter
│           │                                │
│  reject non-base64 images       reject non-base64 images
│  parse OllamaAdapterConfig      parse OllamaAdapterConfig
│  apply num_ctx / think / …      ignore overlay values
│  emit /chat/completions         rewrite path → /messages
│  inherit Bearer                 swap x-api-key → Bearer
│  think-tag + inline-tool repair native thinking / tool_use
│  salvage usage if missing       stock Anthropic parse
└───────────────────────────────────────────────────────────┘
        │
        ▼
source.baseURL + built path
  local  http://localhost:11434/v1
  Cloud  https://ollama.com/v1
```

The harness concatenates `baseURL + path`. Both factories therefore emit paths **without** a second `/v1` (`/chat/completions`, `/messages`). Stock Anthropic `/v1/messages` on a `/v1` base would wire as `/v1/v1/messages`.

## Factories

### `createOllamaAdapter`

OpenAI-compat factory for `POST /v1/chat/completions`.

- Inner adapter: Interchange `createOpenAIAdapter` with **no** OpenAI quirks of its own. Request/response handling is the shipped default except for this overlay.
- `quirks` is this package's `OllamaAdapterConfig`, not Interchange `OpenAIQuirks`.
- `buildRequest` rejects non-base64 images, records declared tool names for inline-JSON repair, then applies the resolved override: `options.num_ctx`, max-tokens (`max_tokens` or `max_completion_tokens`, whichever the inner adapter already set), `reasoning_effort`, `think`, and `stream_options.include_usage`.
- `parseResponse` / `parseJSONResponse` reclassify `<think>` spans into thinking events (unless a native reasoning field already appeared), reclassify declared-tool JSON in `content` into tool-call events, then attach `inference.usage` when Ollama omitted an OpenAI-shaped usage object.

This factory exists because those overlays and repairs live only on OpenAI-compat. The Anthropic factory does not inherit them.

### `createOllamaAnthropicAdapter`

Anthropic factory for `POST /v1/messages`.

- Inner adapter: Interchange `createAnthropicAdapter`.
- `quirks` is still parsed as `OllamaAdapterConfig` so a shared sidecar bag does not fail validation. The values are unused: `/v1/messages` has no context-window field and no OpenAI-compat think overlay.
- `buildRequest` rejects non-base64 images, rewrites the URL to `/messages`, drops `x-api-key`, and sets `Authorization` to the same bearer credential sentinel the OpenAI-compat factory inherits.
- No think-tag stripping and no inline-tool-JSON salvage. Ollama's Anthropic surface already emits native `thinking` and `tool_use` blocks.

This factory exists because the Anthropic surface is first-class on Ollama and would be the wrong shape if forced through OpenAI-compat.

## Shared rules

- **Images.** Both factories reject `url` and file-reference image sources before the request is sent. Ollama does not fetch those; the gate names the offending source so the mistake fails at the adapter.
- **Auth.** Both send `Authorization: Bearer`. Cloud keys come from the source `apiKey`; local typically has none.
- **Registry.** The manifest names a module specifier and an export. It never carries code. The package must already be installed in the sidecar workspace.
- **Instance state.** The registry builds a fresh adapter per request. Think-split and inline-JSON state on `createOllamaAdapter` is therefore per-response, not cross-request.

## Failure modes

| Failure | Where it is caught |
| --- | --- |
| Public URL or file-reference image | Both factories, in `buildRequest` |
| Invalid `OllamaAdapterConfig` | Both factories, at construction (`parseOllamaAdapterConfig`) |
| `baseURL` on native `/api/` | Missed `/v1` paths; not rewritten by this package |
| Silently dropped `num_ctx` | Ruled out on `createOllamaAdapter` by writing `options.num_ctx`; not applicable on the Anthropic factory |
| `<think>` leak / JSON tool call as text | `createOllamaAdapter` parse path only |
| `/v1/v1/messages` | Ruled out by `createOllamaAnthropicAdapter` emitting `/messages` |

Native Ollama `/api/chat` is a different surface and is not a third factory.
