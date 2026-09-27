// Typed operator overrides for the Ollama adapter's built request body:
// context window, max output tokens, and reasoning. Threaded in as
// the `quirks` argument `loadAdapterRegistry`'s resolved factory receives
// (an `InferenceSource.quirks` bag), never a loose passthrough object.

import { type } from "arktype";

export const Reasoning = type("boolean | 'low' | 'medium' | 'high' | 'max'");
export type Reasoning = typeof Reasoning.infer;

export const OllamaAdapterOverride = type({
  "numCtx?": "number.integer > 0",
  "maxOutputTokens?": "number.integer > 0",
  "reasoning?": Reasoning,
  "+": "reject",
});
export type OllamaAdapterOverride = typeof OllamaAdapterOverride.infer;

export const OllamaAdapterConfig = type({
  "default?": OllamaAdapterOverride,
  "perModel?": {
    "[string]": OllamaAdapterOverride,
  },
  "+": "reject",
});
export type OllamaAdapterConfig = typeof OllamaAdapterConfig.infer;

/**
 * Parse the adapter's `quirks` argument into a validated
 * {@link OllamaAdapterConfig}. `undefined`/`null` (no quirks configured for
 * this source) resolves to an empty config, matching every other override
 * class's "unset means unset" convention.
 */
export function parseOllamaAdapterConfig(raw: unknown): OllamaAdapterConfig {
  const validated = OllamaAdapterConfig(raw ?? {});
  if (validated instanceof type.errors) {
    throw new Error(
      `@corbits/ollama-adapter: invalid adapter config: ${validated.summary}`,
    );
  }
  return validated;
}

/**
 * Resolve the effective override for one model: a per-model entry wins
 * field-by-field over the general `default`, and an unconfigured field
 * resolves to `undefined` (no override, built-in adapter behavior).
 */
export function resolveOverride(
  config: OllamaAdapterConfig,
  model: string,
): OllamaAdapterOverride {
  const base = config.default ?? {};
  const perModel = config.perModel?.[model] ?? {};
  const resolved: OllamaAdapterOverride = {};
  const numCtx = perModel.numCtx ?? base.numCtx;
  if (numCtx !== undefined) resolved.numCtx = numCtx;
  const maxOutputTokens = perModel.maxOutputTokens ?? base.maxOutputTokens;
  if (maxOutputTokens !== undefined) resolved.maxOutputTokens = maxOutputTokens;
  const reasoning = perModel.reasoning ?? base.reasoning;
  if (reasoning !== undefined) resolved.reasoning = reasoning;
  return resolved;
}
