// Typed operator overrides for the Ollama adapter's built request body:
// max output tokens and reasoning. Threaded in as
// the `quirks` argument `loadAdapterRegistry`'s resolved factory receives
// (an `InferenceSource.quirks` bag), never a loose passthrough object.

import { getLogger } from "@intx/log";
import { type } from "arktype";

const logger = getLogger(["corbits", "ollama-adapter"]);

export const Reasoning = type("boolean | 'low' | 'medium' | 'high' | 'max'");
export type Reasoning = typeof Reasoning.infer;

export const OllamaAdapterOverride = type({
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
  const validated = OllamaAdapterConfig(migrateLegacyKeys(raw ?? {}));
  if (validated instanceof type.errors) {
    throw new Error(
      `@corbits/ollama-adapter: invalid adapter config: ${validated.summary}`,
    );
  }
  return validated;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Keys from configs written before 0.2.0. `numCtx` and `think` are dropped:
// Ollama's `/v1` surfaces ignore `options.num_ctx` and `think`, so both were
// inert in 0.1, and reading `think` as `reasoning` would start sending
// `reasoning_effort`, which Ollama rejects for non-thinking models.
// `reasoningEffort` becomes `reasoning` unless `reasoning` is set. Each key
// warns once per config location, since the registry builds a fresh adapter
// for every request.
const legacyWarnings = {
  numCtx:
    "Ignoring numCtx; Ollama ignores num_ctx on /v1. Set the context length on the Ollama server (OLLAMA_CONTEXT_LENGTH) or in the model's Modelfile (PARAMETER num_ctx).",
  think:
    "Ignoring think; Ollama ignores it on /v1. Set reasoning to send reasoning_effort.",
  reasoningEffort: "reasoningEffort is deprecated; use reasoning instead.",
};
type LegacyKey = keyof typeof legacyWarnings;
const warned = new Set<string>();

function isLegacyKey(key: string): key is LegacyKey {
  return Object.hasOwn(legacyWarnings, key);
}

function migrateOverride(value: unknown, path: string): unknown {
  if (!isObject(value)) return value;
  const entries = Object.entries(value).filter(([key]) => {
    if (!isLegacyKey(key)) return true;
    const location = `${path}.${key}`;
    if (!warned.has(location)) {
      warned.add(location);
      logger.warn(`${location}: ${legacyWarnings[key]}`);
    }
    return false;
  });
  const effort = value["reasoningEffort"];
  if (effort !== undefined && !("reasoning" in value)) {
    entries.push(["reasoning", effort]);
  }
  return Object.fromEntries(entries);
}

function migrateLegacyKeys(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      if (key === "default") return [key, migrateOverride(value, key)];
      if (key === "perModel" && isObject(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([model, o]) => [
              model,
              migrateOverride(o, `perModel.${model}`),
            ]),
          ),
        ];
      }
      return [key, value];
    }),
  );
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
  const maxOutputTokens = perModel.maxOutputTokens ?? base.maxOutputTokens;
  if (maxOutputTokens !== undefined) resolved.maxOutputTokens = maxOutputTokens;
  const reasoning = perModel.reasoning ?? base.reasoning;
  if (reasoning !== undefined) resolved.reasoning = reasoning;
  return resolved;
}
