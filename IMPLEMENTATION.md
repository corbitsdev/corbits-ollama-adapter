# @corbits/ollama-adapter — Implementation

Concrete wiring for the two factories. Product intent is in `PRODUCT.md`; component relationships are in `ARCHITECTURE.md`.

## Package

| | |
| --- | --- |
| Name | `@corbits/ollama-adapter` `0.1.1` |
| License | LGPL-2.1-only |
| Runtime | Bun `>=1.2`. `engines` does not declare Node; native Node does not load this package's TypeScript source. |
| Export | `"."` → `./src/index.ts` (TypeScript source; Bun consumes it directly) |
| Peers | `@intx/inference` `>=0.3.0`, `@intx/types` `>=0.3.0` |
| Direct dep | `arktype` `2.2.3` (config validation) |

Public exports from `src/index.ts`:

- Factories: `createOllamaAdapter`, `createOllamaAnthropicAdapter`
- Config: `OllamaAdapterConfig`, `OllamaAdapterOverride`, `ReasoningEffort`, `Think`, `parseOllamaAdapterConfig`, `resolveOverride`
- Repair helpers (OpenAI-compat path): think-tag and inline-tool-JSON state machines

## Registration

```
SIDECAR_ADAPTER_MANIFEST=[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAdapter"}]
```

or `"createOllamaAnthropicAdapter"`. Install with `npm` / `pnpm` / `yarn` / `bun add @corbits/ollama-adapter` in the sidecar workspace first — the manifest is a specifier, not a payload.

## Endpoints and credentials

| | Local | Cloud |
| --- | --- | --- |
| `baseURL` | `http://localhost:11434/v1` | `https://ollama.com/v1` |
| OpenAI-compat path | `/chat/completions` | same |
| Anthropic path | `/messages` (not `/v1/messages`) | same |
| Auth | `Authorization: Bearer` (often empty locally) | `Authorization: Bearer` + source `apiKey` |

Do not use `https://ollama.com/api/` as `baseURL`; the factories' `/v1` paths would miss.

`createOllamaAdapter` forces `stream_options.include_usage = true` on the OpenAI-compat body so streams are more likely to carry a usage object. If a chunk still has none, the adapter synthesizes `inference.usage` from OpenAI-shaped `usage` or Ollama `prompt_eval_count` / `eval_count`.

`createOllamaAnthropicAdapter` drops the inner adapter's `x-api-key` header and sets `authorization` to Interchange's `BEARER_CREDENTIAL_SENTINEL`.

## `OllamaAdapterConfig` (`src/overrides.ts`)

Arktype, extra keys rejected.

```ts
{
  default?: {
    numCtx?: integer > 0
    maxOutputTokens?: integer > 0
    reasoningEffort?: "low" | "medium" | "high"
    think?: boolean | "low" | "medium" | "high" | "max"
  }
  perModel?: { [model: string]: /* same override shape */ }
}
```

`resolveOverride` merges per-model over default field-by-field. Unset fields stay unset (inner adapter behavior).

`createOllamaAdapter` writes those fields onto the OpenAI-compat JSON body (`options.num_ctx`, `max_tokens` or `max_completion_tokens`, `reasoning_effort`, `think`). `createOllamaAnthropicAdapter` parses the same bag and ignores the values.

## Layout

```
src/
  index.ts                      # public exports
  adapter.ts                    # both factories, image gate, usage salvage, Anthropic wire
  overrides.ts                  # arktype config + resolveOverride
  think-tags.ts                 # <think> → inference.thinking.* (OpenAI-compat)
  inline-tool-json.ts           # content JSON → inference.tool_call.* (OpenAI-compat)
  adapter.test.ts
  overrides.test.ts
  think-tags.test.ts
  inline-tool-json.test.ts
  anthropic-ollama.spike.test.ts  # live local Ollama; skips if daemon/model/surface missing
```

## Scripts

`bun run typecheck` · `lint` · `format` / `format:check` · `test` · `check` (all of the above except format write).
