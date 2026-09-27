# Contributing

## Packaging

Bun >= 1.2 is the engines floor. The packed tarball ships compiled `dist/` (js + d.ts) built by `bun run build` (also wired as `prepack`); both Bun and native Node resolve the package through `dist` (`main`/`types` plus the `.` export's `default`/`types` conditions).

## How it works

`createOllamaAdapter` reuses Interchange's built-in OpenAI Chat Completions adapter, then overlays `options.num_ctx`, max-tokens, `reasoning_effort`, and `think`, and repairs think-tags / inline tool JSON that Ollama emits on `/v1/chat/completions`. `createOllamaAnthropicAdapter` wraps the stock Anthropic adapter, rewrites the path to `/messages`, and swaps `x-api-key` for the bearer credential sentinel. Ollama's Anthropic surface already emits native `thinking` and `tool_use` blocks, so that path does no think-tag stripping or JSON salvage.
