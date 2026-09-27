# Contributing

## Packaging

Bun >= 1.2 and Node >= 24 are the engines floors. The packed tarball ships compiled `dist/` (js + d.ts) built by `bun run build` (also wired as `prepack`); both Bun and native Node resolve the package through `dist` (`main`/`types` plus the `.` export's `default`/`types` conditions).

## How it works

`createOllamaAdapter` reuses Interchange's built-in OpenAI Chat Completions adapter, then overlays `options.num_ctx`, max-tokens, and `reasoning_effort`, and repairs think-tags / inline tool JSON that Ollama emits on `/v1/chat/completions`. `createOllamaAnthropicAdapter` wraps the stock Anthropic adapter, rewrites the path to `/messages`, maps `reasoning` onto `thinking`, and swaps `x-api-key` for the bearer credential sentinel. Ollama's Anthropic surface already emits native `thinking` and `tool_use` blocks, so that path does no think-tag stripping or JSON salvage.
