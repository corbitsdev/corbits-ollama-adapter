# @corbits/ollama-adapter

Interchange inference adapters for Ollama's two first-class HTTP surfaces. `createOllamaAdapter` wraps OpenAI-compat `POST /v1/chat/completions`; `createOllamaAnthropicAdapter` wraps Anthropic `POST /v1/messages`. Each surface keeps its native shape.

## Runtime support

Bun >= 1.2 or Node >= 24. Peers: `@intx/inference` and `@intx/types` (^0.4.0).

## Quickstart

```bash
npm add @corbits/ollama-adapter
```

A host never calls this package's factories directly. It installs the
package in the sidecar's workspace, then registers a provider id on the
sidecar's `SIDECAR_ADAPTER_MANIFEST` env var — a JSON array of
`{ provider, specifier, export }` entries the sidecar validates and loads
with `import()` at boot:

```sh
SIDECAR_ADAPTER_MANIFEST='[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAdapter"}]'
```

Use `"createOllamaAnthropicAdapter"` instead for the Anthropic surface. The
Anthropic factory parses the same quirks bag so a shared sidecar config does
not fail validation, then applies only `reasoning`: `numCtx` and
`maxOutputTokens` are not applied to the `/v1/messages` body. A hub that
spawns sidecars forwards its own `SIDECAR_ADAPTER_MANIFEST` to every sidecar
it starts, so this is one setting at the hub, not per-sidecar config.

Point the connected source's `baseURL` at local `http://localhost:11434/v1`
or Cloud `https://ollama.com/v1`: the host concatenates `baseURL + path`, so
the factories emit `/chat/completions` and `/messages` (not `/v1/messages`),
and both send `Authorization: Bearer`. The native `https://ollama.com/api/`
surface uses different paths. Send images as base64 on both factories. Cloud
models are the catalog at
[ollama.com/search?c=cloud](https://ollama.com/search?c=cloud), not whatever
is pulled locally — this package leaves source selection and pricing to your
Ollama account.

## Lower-level: calling a factory directly

`SIDECAR_ADAPTER_MANIFEST` loading is just `import()` plus a call to the
named export — a host that resolves its own adapters (no sidecar-manifest
step) can call either factory directly with a source and, for
`createOllamaAdapter`, an overrides bag:

```ts
import { createOllamaAdapter } from "@corbits/ollama-adapter";
import type { LastCycleSource } from "@intx/types/runtime";

const source: LastCycleSource = {
  sourceId: "ollama/local",
  provider: "ollama",
  model: "gpt-oss:20b",
};

export const adapter = createOllamaAdapter(source, {
  default: { numCtx: 8192, maxOutputTokens: 4096 },
  perModel: { "gpt-oss:20b": { reasoning: "high" } },
});
```

`reasoning` is one setting translated per factory. Ollama's
`/v1/chat/completions` only honors `reasoning_effort`, and `/v1/messages`
only honors the Anthropic `thinking` switch (both ignore `think`), so an
effort level cannot be expressed on the messages factory. `true` sends
Ollama's own default effort, `medium`. On the messages factory,
`reasoning: false` always disables thinking; otherwise a per-call thinking
option is sent as requested:

| `reasoning`                               | `createOllamaAdapter` sends  | `createOllamaAnthropicAdapter` sends                 |
| ----------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `false`                                   | `reasoning_effort: "none"`   | `thinking: { type: "disabled" }`                     |
| `true`                                    | `reasoning_effort: "medium"` | `thinking: { type: "enabled", budget_tokens: 1024 }` |
| `"low"` / `"medium"` / `"high"` / `"max"` | `reasoning_effort` as given  | `thinking: { type: "enabled", budget_tokens: 1024 }` |
| unset                                     | nothing                      | nothing                                              |

On the messages factory, a thinking `budget_tokens` at or above `max_tokens`
throws at `buildRequest`.

## Development

```sh
git clone https://github.com/corbitsdev/corbits-ollama-adapter.git
cd corbits-ollama-adapter
bun install
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run check          # typecheck + lint + format:check + test
```

`tests/live-ollama.test.ts` drives both factories against the Ollama at `OLLAMA_BASE_URL` (model `OLLAMA_MODEL`, default `gpt-oss:20b`) and skips when the variable is unset or the model or surface is missing. `tests/reasoning-live.test.ts` checks the `reasoning` field on both surfaces against the same server (model `OLLAMA_REASONING_MODEL`, default `qwen3:8b`).

See [CONTRIBUTING.md](./CONTRIBUTING.md) for packaging and internals.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
