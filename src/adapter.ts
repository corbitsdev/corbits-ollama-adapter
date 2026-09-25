// The `ollama` provider adapter wraps Interchange's built-in OpenAI Chat
// Completions adapter against Ollama's OpenAI-compat `/v1/chat/completions`
// (SSE parsing, retry/pacing header extraction, message marshaling — all
// unmodified). `buildRequest` then applies operator-configured overrides
// onto the request body before it ships.
//
// Ollama also serves Anthropic `/v1/messages` as a first-class surface
// (docs.ollama.com/api/anthropic-compatibility.md). `createOllamaAnthropicAdapter`
// wraps stock `createAnthropicAdapter` against that path; this OpenAI-compat
// wrapper stays because that is where `options.num_ctx` and the
// OpenAI-compat think-tag / inline-tool-JSON repairs live.
//
// Ollama's openai-compatible `/v1/chat/completions` endpoint takes
// `max_tokens` (mapped internally to Ollama's native `num_predict`) but has
// no OpenAI-shaped field for context window — that rides through the
// endpoint's `options` passthrough object as `options.num_ctx`, exactly
// like a native `/api/chat` call. A silently-dropped `num_ctx` (set on the
// wrong field, or as a top-level key the endpoint ignores) is the failure
// mode this adapter exists to rule out. Reasoning effort rides through the
// same `reasoning_effort` field Ollama already recognizes for gpt-oss
// models on this endpoint.
import {
  BEARER_CREDENTIAL_SENTINEL,
  type AdapterFactory,
  type BuiltRequest,
  type ProviderAdapter,
} from "@intx/inference";
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
} from "@intx/inference/providers";
import type {
  ConversationTurn,
  InferenceEvent,
  LastCycleSource,
  TokenUsage,
} from "@intx/types/runtime";

import {
  parseOllamaAdapterConfig,
  resolveOverride,
  type OllamaAdapterOverride,
} from "./overrides.js";
import {
  createThinkSplitState,
  reclassifyThinkingEvents,
} from "./think-tags.js";
import {
  createInlineToolJsonState,
  reclassifyInlineToolJsonEvents,
  responseChunkIsTerminal,
  setDeclaredToolNames,
} from "./inline-tool-json.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(
      "@corbits/ollama-adapter: built request body is not a JSON object",
    );
  }
  return parsed;
}

// Ollama's OpenAI-compat and Anthropic `/v1/messages` surfaces only
// accept base64 image bytes (docs.ollama.com/api/openai-compatibility.md
// `data:` image_url; docs.ollama.com/api/anthropic-compatibility.md
// "Image content (base64)"). They do not fetch a public URL the way
// OpenAI/Anthropic themselves do. The built-in OpenAI adapter's `url`-kind
// MediaSource support (see providers/openai.js) passes a public URL
// straight through; the stock Anthropic adapter emits `type: "url"` /
// `type: "file"` sources (see providers/anthropic.js `toAnthropicMediaSource`).
// Against Ollama that lands as a request the server either fails on with
// an opaque error or, worse, appears to accept while never actually
// seeing the image. Rejecting the non-base64 source here, with the
// offending URL named, surfaces the mismatch at the point the mistake
// was made instead of downstream. Both factories share this gate.
function rejectNonBase64Images(messages: readonly ConversationTurn[]): void {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "image") continue;
      if (block.source.kind === "base64") continue;
      const described =
        block.source.kind === "url"
          ? block.source.url
          : `file-reference:${block.source.reference}`;
      throw new Error(
        `@corbits/ollama-adapter: image source must be base64; ` +
          `Ollama does not fetch a ${block.source.kind} source ` +
          `(received ${described}).`,
      );
    }
  }
}

function applyOverride(
  built: BuiltRequest,
  override: OllamaAdapterOverride,
): BuiltRequest {
  const body = parseJsonObject(built.body);
  // Without include_usage, Ollama's OpenAI-compat stream often ends with no
  // usage object; the harness then synthesizes zero token counts that Insights
  // used to display as Cost $0.00 / 0/0.
  body["stream_options"] = { include_usage: true };
  if (override.numCtx !== undefined) {
    const options = isPlainObject(body["options"]) ? body["options"] : {};
    body["options"] = { ...options, num_ctx: override.numCtx };
  }
  if (override.maxOutputTokens !== undefined) {
    // The built-in adapter already set whichever of these two fields its
    // quirks resolved to; overwrite that same field rather than assuming
    // one, so the override wins regardless of which one is in play.
    if (body["max_completion_tokens"] !== undefined) {
      body["max_completion_tokens"] = override.maxOutputTokens;
    } else {
      body["max_tokens"] = override.maxOutputTokens;
    }
  }
  if (override.reasoningEffort !== undefined) {
    body["reasoning_effort"] = override.reasoningEffort;
  }
  if (override.think !== undefined) {
    body["think"] = override.think;
  }
  return { ...built, body: JSON.stringify(body) };
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function openaiShapedUsage(value: unknown): TokenUsage | null {
  if (!isPlainObject(value)) return null;
  const input = asNonNegativeInt(value["prompt_tokens"]);
  const output = asNonNegativeInt(value["completion_tokens"]);
  if (input === null && output === null) return null;
  const details = value["prompt_tokens_details"];
  const completionDetails = value["completion_tokens_details"];
  const cacheRead = isPlainObject(details)
    ? asNonNegativeInt(details["cached_tokens"])
    : null;
  const thinking = isPlainObject(completionDetails)
    ? asNonNegativeInt(completionDetails["reasoning_tokens"])
    : null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: 0,
    thinking: thinking ?? 0,
  };
}

function ollamaTokenUsageFromChunk(raw: string): TokenUsage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const fromUsage = openaiShapedUsage(parsed["usage"]);
    if (fromUsage !== null) return fromUsage;
    const input = asNonNegativeInt(parsed["prompt_eval_count"]);
    const output = asNonNegativeInt(parsed["eval_count"]);
    if (input === null && output === null) return null;
    return {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    };
  } catch {
    // report-error-ignore: a non-JSON SSE chunk is the common case, not a
    // failure — this function is "usage if present", never an error path.
    return null;
  }
}

function withOllamaUsage(
  events: readonly InferenceEvent[],
  raw: string,
  source: LastCycleSource,
): InferenceEvent[] {
  if (events.some((event) => event.type === "inference.usage")) {
    return [...events];
  }
  const usage = ollamaTokenUsageFromChunk(raw);
  if (usage === null) return [...events];
  return [
    ...events,
    {
      type: "inference.usage",
      seq: 0,
      data: { usage, source },
    },
  ];
}

/**
 * OpenAI-compat `AdapterFactory` for Ollama `/v1/chat/completions`. A
 * `SIDECAR_ADAPTER_MANIFEST` entry may name this export. `quirks` is this
 * package's own {@link OllamaAdapterConfig} (an `InferenceSource.quirks`
 * bag), not the built-in adapter's `OpenAIQuirks` — the wrapped adapter is
 * constructed with no quirks of its own, so its request/response handling
 * is exactly the shipped default except for this override pass.
 */
export const createOllamaAdapter: AdapterFactory = (
  source: LastCycleSource,
  quirks?: unknown,
): ProviderAdapter => {
  const config = parseOllamaAdapterConfig(quirks);
  const inner = createOpenAIAdapter(source);
  // One split state per adapter instance: the registry resolves a fresh
  // adapter per request (see `createAdapterRegistry`'s own doc comment),
  // so this safely tracks "are we inside a `<think>` span" across every
  // chunk of one response without leaking state between requests.
  const streamThinkState = createThinkSplitState();
  const jsonThinkState = createThinkSplitState();
  const streamInlineState = createInlineToolJsonState();
  const jsonInlineState = createInlineToolJsonState();
  return {
    ...inner,
    buildRequest: (messages, model, options) => {
      rejectNonBase64Images(messages);
      setDeclaredToolNames(streamInlineState, options.tools);
      setDeclaredToolNames(jsonInlineState, options.tools);
      return applyOverride(
        inner.buildRequest(messages, model, options),
        resolveOverride(config, model),
      );
    },
    parseResponse: (sseData) =>
      withOllamaUsage(
        reclassifyInlineToolJsonEvents(
          reclassifyThinkingEvents(
            inner.parseResponse(sseData),
            streamThinkState,
          ),
          streamInlineState,
          { flush: responseChunkIsTerminal(sseData) },
        ),
        sseData,
        source,
      ),
    parseJSONResponse: (body) =>
      withOllamaUsage(
        reclassifyInlineToolJsonEvents(
          reclassifyThinkingEvents(
            inner.parseJSONResponse(body),
            jsonThinkState,
          ),
          jsonInlineState,
          { flush: true },
        ),
        body,
        source,
      ),
  };
};

/**
 * Anthropic `AdapterFactory` for Ollama `/v1/messages`. A
 * `SIDECAR_ADAPTER_MANIFEST` entry may name this export instead of
 * {@link createOllamaAdapter}. Wraps Interchange's stock
 * `createAnthropicAdapter` with no OpenAI-compat think-tag stripping,
 * inline-tool-JSON salvage, or `num_ctx` overlay — that surface has no
 * context-window field. Non-base64 images are rejected the same way as
 * on the OpenAI-compat factory; Ollama's Anthropic surface only accepts
 * base64 image content. `quirks` is still parsed as
 * {@link OllamaAdapterConfig} so a shared sidecar bag does not 400 the
 * stock Anthropic quirks validator; the values are unused on this path.
 *
 * Workbench catalog and Cloud sources already use a `/v1` base
 * (`http://localhost:11434/v1`, `https://ollama.com/v1`). The harness
 * concatenates `baseURL + built.url`, so this factory emits `/messages`
 * (matching OpenAI-compat `/chat/completions`) rather than stock
 * Anthropic `/v1/messages`, which would wire as `/v1/v1/messages`.
 * Ollama Cloud expects `Authorization: Bearer`, so the stock
 * `x-api-key` header is replaced with the same bearer credential
 * sentinel {@link createOllamaAdapter} inherits from OpenAI-compat.
 */
export const createOllamaAnthropicAdapter: AdapterFactory = (
  source: LastCycleSource,
  quirks?: unknown,
): ProviderAdapter => {
  parseOllamaAdapterConfig(quirks);
  const inner = createAnthropicAdapter(source);
  return {
    ...inner,
    buildRequest: (messages, model, options) => {
      rejectNonBase64Images(messages);
      return withOllamaAnthropicWire(
        inner.buildRequest(messages, model, options),
      );
    },
  };
};

function withOllamaAnthropicWire(built: BuiltRequest): BuiltRequest {
  const { ["x-api-key"]: _dropped, ...headers } = built.headers;
  return {
    ...built,
    url: "/messages",
    headers: {
      ...headers,
      authorization: BEARER_CREDENTIAL_SENTINEL,
    },
  };
}
