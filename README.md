# @corbits/ollama-adapter

Interchange inference adapters for Ollama's two first-class HTTP surfaces. `createOllamaAdapter` wraps OpenAI-compat `POST /v1/chat/completions`; `createOllamaAnthropicAdapter` wraps Anthropic `POST /v1/messages`. Each surface keeps its native shape.

## Runtime support

Bun >= 1.2 is the engines floor and consumes TypeScript source directly. `engines` does not declare Node; native Node does not load this package's TypeScript source. Peers: `@intx/inference` and `@intx/types` (>= 0.3.0).

## Quickstart

```bash
npm add @corbits/ollama-adapter
pnpm add @corbits/ollama-adapter
yarn add @corbits/ollama-adapter
bun add @corbits/ollama-adapter
```

Register either factory on the `ollama` provider key via `SIDECAR_ADAPTER_MANIFEST`. Install the package in the sidecar workspace first — the manifest names a module.

OpenAI-compat (`/v1/chat/completions`):

```
SIDECAR_ADAPTER_MANIFEST=[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAdapter"}]
```

Anthropic (`/v1/messages`):

```
SIDECAR_ADAPTER_MANIFEST=[{"provider":"ollama","specifier":"@corbits/ollama-adapter","export":"createOllamaAnthropicAdapter"}]
```

Point the source `baseURL` at local `http://localhost:11434/v1` or Cloud `https://ollama.com/v1`. The host concatenates `baseURL + path`, so the factories emit `/chat/completions` and `/messages` (not `/v1/messages`). Both send `Authorization: Bearer`. Use `/v1` base URLs here; the native `https://ollama.com/api/` surface uses different paths.

```ts
import type { AdapterManifest } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import type { InferenceSource } from "@intx/types/runtime";

const manifest: AdapterManifest = [
  {
    provider: "ollama",
    specifier: "@corbits/ollama-adapter",
    export: "createOllamaAdapter",
  },
  // Or: export: "createOllamaAnthropicAdapter"
];

const adapters = await loadAdapterRegistry(manifest);

const local: InferenceSource = {
  id: "ollama/local",
  provider: "ollama",
  baseURL: "http://localhost:11434/v1",
  model: "gpt-oss:20b",
};

const cloud: InferenceSource = {
  id: "ollama/cloud",
  provider: "ollama",
  baseURL: "https://ollama.com/v1",
  apiKey: "<key from ollama.com/settings/keys>",
  model: "gpt-oss:20b",
};

// OpenAI-compat quirks (createOllamaAdapter). The Anthropic factory parses
// the same bag so a shared sidecar config does not fail validation, then
// ignores the values — /v1/messages has no num_ctx / think overlay.
const quirks = {
  default: {
    numCtx: 8192,
    maxOutputTokens: 4096,
    reasoningEffort: "medium",
    think: "medium",
  },
  perModel: {
    "gpt-oss:20b": { numCtx: 32768, reasoningEffort: "high" },
  },
};
```

Send images as base64 on both factories. Cloud models are the catalog at [ollama.com/search?c=cloud](https://ollama.com/search?c=cloud), not whatever is pulled locally. Bring your own Cloud source — the package leaves source selection and pricing to your Ollama account.

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
