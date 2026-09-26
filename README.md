# @corbits/ollama-adapter

`@intx/inference` provider adapters for Ollama's OpenAI-compatible `/v1/chat/completions` and Anthropic-compatible `/v1/messages` surfaces. A Corbits inference provider that plugs into the Interchange adapter registry and also works in any host that runs `@intx/inference`.

## Why @corbits/ollama-adapter?

1. **Clean streams from local models.** Many Ollama models emit chain-of-thought inside `<think>` tags or tool calls as raw JSON in the text. `createOllamaAdapter` reclassifies both into thinking and tool-call events before they reach the agent.
2. **One reasoning setting for both surfaces.** `reasoning` is sent as `reasoning_effort` on `/v1/chat/completions` and as the Anthropic `thinking` switch on `/v1/messages`, set per model or as a default.
3. **Local or Ollama Cloud.** Point the same source at a local `ollama serve` or at Ollama Cloud. Both surfaces keep their native request shape and use `Authorization: Bearer`.

It does not cover Ollama's native `/api` endpoints.

## Install

```bash
bun add @corbits/ollama-adapter @intx/inference@^0.4.0 @intx/log@^0.4.0 @intx/types@^0.4.0
```

Runs on Bun >= 1.2 or Node >= 24.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals (accounts that hold their own identity, permissions and credentials). Corbits packages add what an agent product needs around it.

- **Runs in:** the agent sidecar (the runtime next to each agent), or any process that calls `runInference`. No hub (the multi-tenant control plane) is required.
- **Plugs into:** the [`@intx/inference`](https://github.com/faremeter/interchange/tree/main/packages/inference) adapter registry, as the factory for an Ollama provider id.
- **Pairs with:** [`@corbits/openai-responses`](https://github.com/corbitsdev/corbits-openai-responses) and [`@corbits/system-one`](https://github.com/corbitsdev/corbits-system-one), the other Corbits inference providers.

## Reference

| Export                         | Description                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `createOllamaAdapter`          | `AdapterFactory` for `/v1/chat/completions`. Applies every config field.              |
| `createOllamaAnthropicAdapter` | `AdapterFactory` for `/v1/messages`. Accepts the same config and applies `reasoning`. |
| `OllamaAdapterConfig`          | Schema and type for the source's `quirks`: `{ default?, perModel? }` of overrides.    |
| `OllamaAdapterOverride`        | Schema and type for one override. Unknown keys are rejected.                          |
| `Reasoning`                    | Schema and type for `reasoning`: `boolean \| "low" \| "medium" \| "high" \| "max"`.   |

Set the source's `baseURL` to `http://localhost:11434/v1` or `https://ollama.com/v1`. The factories append `/chat/completions` and `/messages`. Send images as base64.

### Overrides

A `perModel` entry wins field by field over `default`. An unset field leaves the request unchanged.

| Field             | Type                | `createOllamaAdapter` sends | `createOllamaAnthropicAdapter` sends |
| ----------------- | ------------------- | --------------------------- | ------------------------------------ |
| `maxOutputTokens` | positive integer    | `max_tokens`                | nothing                              |
| `reasoning`       | see the table below | `reasoning_effort`          | `thinking`                           |

| `reasoning`                               | `createOllamaAdapter`        | `createOllamaAnthropicAdapter`                       |
| ----------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `false`                                   | `reasoning_effort: "none"`   | `thinking: { type: "disabled" }`                     |
| `true`                                    | `reasoning_effort: "medium"` | `thinking: { type: "enabled", budget_tokens: 1024 }` |
| `"low"` / `"medium"` / `"high"` / `"max"` | `reasoning_effort` as given  | `thinking: { type: "enabled", budget_tokens: 1024 }` |

`/v1/messages` has no effort levels, so every level enables thinking with the same budget. On that factory, `reasoning: false` always disables thinking; otherwise a per-call thinking option wins. With `reasoning` set, a thinking `budget_tokens` at or above `max_tokens` throws at `buildRequest`.

Ollama ignores `num_ctx` on `/v1`. Set the context length on the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, or with `PARAMETER num_ctx 32768` in the model's Modelfile.

## Using with Interchange

The sidecar loads custom adapters from the `SIDECAR_ADAPTER_MANIFEST` env var, a JSON array of `{ provider, specifier, export }` entries. Install this package in the sidecar's workspace and register a provider id:

```bash
SIDECAR_ADAPTER_MANIFEST='[
  {"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAdapter"}
]'
```

Use `createOllamaAnthropicAdapter` as the export for the `/v1/messages` surface. A hub that spawns sidecars forwards its own `SIDECAR_ADAPTER_MANIFEST` to each one, so set it once on the hub. Sources with that `provider` then resolve to this adapter, and each source's `quirks` holds its `OllamaAdapterConfig`.

## Upgrading from 0.1

- `reasoningEffort` and `think` are replaced by `reasoning`. Old configs still load: each key logs one warning and is read as `reasoning` (`think` first; an explicit `reasoning` wins).
- `numCtx` is removed because Ollama ignores it on `/v1`. Old configs still load: the key logs one warning and is dropped. Set the context length on the server instead.
- `createOllamaAnthropicAdapter` now applies `reasoning` and throws when the thinking budget is at or above `max_tokens`.
- `parseOllamaAdapterConfig`, `resolveOverride` and the think-tag and inline-JSON helpers are no longer exported.
- `@intx/log` is a new peer. All `@intx/*` peers are now `^0.4.0`, which excludes 0.5.

## License

[LGPL-2.1-only](https://github.com/corbitsdev/corbits-ollama-adapter/blob/main/LICENSE)
