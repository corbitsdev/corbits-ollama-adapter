# Contributing

## Packaging

Bun >= 1.2 and Node >= 24 are the engines floors. The packed tarball ships compiled `dist/` (js + d.ts) built by `bun run build` (also wired as `prepack`); both Bun and native Node resolve the package through `dist` (`main`/`types` plus the `.` export's `default`/`types` conditions).

## How it works

`createOllamaAdapter` reuses Interchange's built-in OpenAI Chat Completions adapter, then overlays max-tokens and `reasoning_effort`, and repairs think-tags / inline tool JSON that Ollama emits on `/v1/chat/completions`. `createOllamaAnthropicAdapter` wraps the stock Anthropic adapter, rewrites the path to `/messages`, maps `reasoning` onto `thinking`, and swaps `x-api-key` for the bearer credential sentinel. Ollama's Anthropic surface already emits native `thinking` and `tool_use` blocks, so that path does no think-tag stripping or JSON salvage.

## Development

```sh
bun install
bun run check          # typecheck + lint + format:check + unit tests
bun run test:e2e       # inference-harness and live Ollama suites
```

`e2e/harness.test.ts` drives the adapter through `@intx/inference-testing` and always runs. The live suites run only when `OLLAMA_BASE_URL` names an Ollama server (for example `http://host:11434`) and skip otherwise. `e2e/live-ollama.test.ts` drives both factories with model `OLLAMA_MODEL` (default `gpt-oss:20b`); `e2e/reasoning-live.test.ts` checks `reasoning` on both surfaces with model `OLLAMA_REASONING_MODEL` (default `qwen3:8b`).

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.
