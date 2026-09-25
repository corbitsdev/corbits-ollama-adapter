# @corbits/ollama-adapter

Interchange inference adapters for Ollama's two first-class HTTP surfaces. `createOllamaAdapter` wraps OpenAI-compat `POST /v1/chat/completions`; `createOllamaAnthropicAdapter` wraps Anthropic `POST /v1/messages`. Each surface keeps its native shape.

## Runtime support

Bun >= 1.2 is the engines floor. The packed tarball ships compiled `dist/` (js + d.ts) built by `bun run build` (also wired as `prepack`); both Bun and native Node resolve the package through `dist` (`main`/`types` plus the `.` export's `default`/`types` conditions). Peers: `@intx/inference` and `@intx/types` (>= 0.3.0).

## Quickstart

```bash
npm add @corbits/ollama-adapter
pnpm add @corbits/ollama-adapter
yarn add @corbits/ollama-adapter
bun add @corbits/ollama-adapter
```

A host never calls this package's factories directly. It installs the
package in the sidecar's workspace, then registers a provider id on the
sidecar's `SIDECAR_ADAPTER_MANIFEST` env var — a JSON array of
`{ provider, specifier, export }` entries the sidecar validates and loads
with `import()` at boot:

```sh
SIDECAR_ADAPTER_MANIFEST=[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAdapter"}]
```

Use `"createOllamaAnthropicAdapter"` instead for the Anthropic surface. The
Anthropic factory parses the same quirks bag so a shared sidecar config does
not fail validation, then ignores the values — `/v1/messages` has no
num_ctx / think overlay. A hub that spawns sidecars (e.g. Workbench's process
provisioner) forwards its own `SIDECAR_ADAPTER_MANIFEST` to every sidecar it
starts, so this is one setting at the hub, not per-sidecar config.

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
  perModel: { "gpt-oss:20b": { reasoningEffort: "high" } },
});
```

## How it works

`createOllamaAdapter` reuses Interchange's built-in OpenAI Chat Completions adapter, then overlays `options.num_ctx`, max-tokens, `reasoning_effort`, and `think`, and repairs think-tags / inline tool JSON that Ollama emits on `/v1/chat/completions`. `createOllamaAnthropicAdapter` wraps the stock Anthropic adapter, rewrites the path to `/messages`, and swaps `x-api-key` for the bearer credential sentinel. Ollama's Anthropic surface already emits native `thinking` and `tool_use` blocks, so that path does no think-tag stripping or JSON salvage.

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

`src/anthropic-ollama.spike.test.ts` drives `createOllamaAnthropicAdapter` against a local Ollama and skips when the daemon, model, or `/v1/messages` is missing.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
