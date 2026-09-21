# @corbits/ollama-adapter — Product

Ollama as an Interchange inference source. Operators register this package on the `ollama` provider key and point a source at local Ollama or Ollama Cloud. Agents then call Ollama through the same inference plane as every other provider.

Ollama ships two first-class HTTP surfaces. This package exposes **both**; neither replaces the other.

| Factory | Surface | Who it is for |
| --- | --- | --- |
| `createOllamaAdapter` | OpenAI-compat `POST /v1/chat/completions` | Operators who need Ollama's OpenAI-compat overlays (`num_ctx`, `think`, `reasoning_effort`) and the repairs that surface needs |
| `createOllamaAnthropicAdapter` | Anthropic `POST /v1/messages` | Operators who want Ollama's native `thinking` / `tool_use` blocks on the Anthropic path |

A sidecar manifest names **one** export per `ollama` provider entry. The operator chooses the surface; the package does not pick a default or hide one factory behind the other.

## Why it exists

Interchange's built-in OpenAI and Anthropic adapters are almost right for Ollama and almost wrong in the places that hurt:

- Context window on OpenAI-compat is `options.num_ctx`, not an OpenAI-shaped field. A silently dropped window is the failure this adapter exists to rule out.
- Some OpenAI-compat models emit `<think>` tags or tool calls as JSON in `content`. Left alone, that text leaks as the reply and tools never run.
- Ollama's Anthropic surface already emits native blocks, but it wants `/messages` on a `/v1` base and `Authorization: Bearer`, not stock Anthropic `/v1/messages` + `x-api-key`.
- Both surfaces accept **base64 images only**. A public URL that OpenAI or Anthropic would fetch is a request Ollama never actually sees.

Wrapping the stock adapters, rather than replacing Interchange, keeps SSE parsing, retries, and message marshaling in one place.

## Goals

- Operators can run local (`http://localhost:11434/v1`) or Cloud (`https://ollama.com/v1`) with the same factories.
- Both factories are public, documented, and installable from `@corbits/ollama-adapter`.
- Images that are not base64 fail at the adapter, with the offending source named, instead of downstream as an opaque model error.
- Cloud models are the catalog at [ollama.com/search?c=cloud](https://ollama.com/search?c=cloud), not whatever is pulled locally.

## Not in scope

- Native `https://ollama.com/api/` (or `/api/chat`). That surface misses the `/v1` paths the factories emit.
- A default Cloud source, bundled API key, or pricing table. This package ships none of those.
- Choosing a factory for the operator. The manifest export is the choice.

## Target users

Sidecar and Workbench operators who already have Interchange inference, and anyone registering an `AdapterManifest` entry for `provider: "ollama"`.
