# AGENTS.md

## Purpose

`@corbits/ollama-adapter` provides `@intx/inference` adapter factories for Ollama's OpenAI-compatible `/v1/chat/completions` and Anthropic-compatible `/v1/messages` surfaces. It owns the request overrides (`maxOutputTokens`, `reasoning`) and the stream repairs Ollama needs on `/v1/chat/completions`. It does not own SSE parsing or message marshaling (the wrapped Interchange adapters) or Ollama's native `/api` endpoints.

## Layout

- `src/adapter.ts`: `createOllamaAdapter` (wraps the OpenAI Chat Completions adapter) and `createOllamaAnthropicAdapter` (wraps the Anthropic adapter on `/messages`).
- `src/overrides.ts`: the `OllamaAdapterConfig`, `OllamaAdapterOverride` and `Reasoning` schemas, legacy-key migration and per-model resolution.
- `src/think-tags.ts`: reclassifies inline `<think>` text into thinking deltas.
- `src/inline-tool-json.ts`: reclassifies a tool call emitted as JSON text into tool-call events.
- `src/index.ts`: the public entry (the two factories and three schemas).
- `src/*.test.ts`: unit tests next to the module they cover.
- `e2e/`: the inference-harness suite and the live suites gated on `OLLAMA_BASE_URL`.

## Rules

- Consume `@intx/inference`, `@intx/log` and `@intx/types` as `peerDependencies` (`^0.4.0`), never vendored. A host must resolve exactly one copy.
- Parse the `quirks` bag with arktype; unknown override keys are rejected.
- `exactOptionalPropertyTypes` is on: omit optional keys, never assign `undefined` to them.
- Leave the wrapped adapters' parsing unmodified; repairs apply only on the OpenAI-compatible surface, since Ollama's Anthropic surface already emits native `thinking` and `tool_use` blocks.

## Local development

```sh
bun install && bun run check
```
