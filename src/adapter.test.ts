import { describe, expect, test } from "bun:test";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";
import type { LastCycleSource } from "@intx/types/runtime";
import type {
  ConversationTurn,
  InferenceEvent,
  InferenceOptions,
  ToolDefinition,
} from "@intx/types/runtime";

import { createOllamaAdapter, createOllamaAnthropicAdapter } from "./adapter";

const source: LastCycleSource = {
  sourceId: "ollama-test",
  provider: "ollama",
  model: "gpt-oss:20b",
};

const messages: ConversationTurn[] = [
  {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 0,
  },
];

const options: InferenceOptions = {};

const memorySearchTool: ToolDefinition = {
  name: "memory_search",
  description: "Search firm memory",
  inputSchema: { type: "object" },
};

const CL_7186_PAYLOAD =
  '{"name":"memory_search","parameters":{"query":"this person"}}';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyOf(built: { body: string }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(built.body);
  if (!isPlainObject(parsed)) {
    throw new Error("expected request body to be a JSON object");
  }
  return parsed;
}

/** Mirrors `@intx/inference` harness `resolveURL`: string concat of base + path. */
function resolveHarnessURL(path: string, baseURL: string): string {
  const base = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  return base + path;
}

function isToolCallStart(
  event: InferenceEvent,
): event is Extract<InferenceEvent, { type: "inference.tool_call.start" }> {
  return event.type === "inference.tool_call.start";
}

function isToolCallDelta(
  event: InferenceEvent,
): event is Extract<InferenceEvent, { type: "inference.tool_call.delta" }> {
  return event.type === "inference.tool_call.delta";
}

function isToolCallStartOrDelta(
  event: InferenceEvent,
): event is Extract<
  InferenceEvent,
  { type: "inference.tool_call.start" | "inference.tool_call.delta" }
> {
  return (
    event.type === "inference.tool_call.start" ||
    event.type === "inference.tool_call.delta"
  );
}

function toolStarts(
  events: readonly InferenceEvent[],
): Extract<InferenceEvent, { type: "inference.tool_call.start" }>[] {
  return events.filter(isToolCallStart);
}

function textDeltas(events: readonly InferenceEvent[]): InferenceEvent[] {
  return events.filter((event) => event.type === "inference.text.delta");
}

function argumentFragments(events: readonly InferenceEvent[]): string {
  return events
    .filter(isToolCallDelta)
    .map((event) => event.data.argumentFragment)
    .join("");
}

function expectSharedToolCallId(events: readonly InferenceEvent[]): void {
  const ids = events
    .filter(isToolCallStartOrDelta)
    .map((event) => event.data.callId);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids)).toEqual(new Set(["ollama-inline-0"]));
}

describe("createOllamaAdapter", () => {
  test("no override configured leaves the body equivalent to the built-in adapter's", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const inner = createOpenAIAdapter(source);
    const wrappedBuilt = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    const innerBuilt = inner.buildRequest(messages, "gpt-oss:20b", options);
    const wrappedBody = bodyOf(wrappedBuilt);
    const { stream_options: _streamOptions, ...rest } = wrappedBody;
    expect(rest).toEqual(bodyOf(innerBuilt));
    expect(wrappedBuilt.url).toBe(innerBuilt.url);
    expect(wrappedBuilt.headers).toEqual(innerBuilt.headers);
  });

  test("a configured num_ctx and max output tokens appear in the built request body", () => {
    const wrapped = createOllamaAdapter(source, {
      default: { numCtx: 32768, maxOutputTokens: 2048 },
    });
    const built = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    const body = bodyOf(built);
    expect(body["options"]).toEqual({ num_ctx: 32768 });
    expect(body["max_tokens"]).toBe(2048);
  });

  test.each([
    [true, "medium"],
    [false, "none"],
    ["low", "low"],
    ["high", "high"],
    ["max", "max"],
  ] as const)(
    "reasoning %p is sent as reasoning_effort %p",
    (reasoning, effort) => {
      const wrapped = createOllamaAdapter(source, { default: { reasoning } });
      const body = bodyOf(wrapped.buildRequest(messages, "qwen3:8b", options));
      expect(body["reasoning_effort"]).toBe(effort);
      expect(body).not.toHaveProperty("think");
    },
  );

  test("an unconfigured reasoning override is omitted from the built request body", () => {
    const wrapped = createOllamaAdapter(source, {});
    const built = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    expect(bodyOf(built)).not.toHaveProperty("reasoning_effort");
  });

  test("a per-model override beats the general default", () => {
    const wrapped = createOllamaAdapter(source, {
      default: { numCtx: 8192 },
      perModel: { "gpt-oss:20b": { numCtx: 65536 } },
    });
    const forOverriddenModel = bodyOf(
      wrapped.buildRequest(messages, "gpt-oss:20b", options),
    );
    const forOtherModel = bodyOf(
      wrapped.buildRequest(messages, "qwen3.8:27b", options),
    );
    expect(forOverriddenModel["options"]).toEqual({ num_ctx: 65536 });
    expect(forOtherModel["options"]).toEqual({ num_ctx: 8192 });
  });

  test("preserves the built-in adapter's response parsing and header extractors", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const chunk = JSON.stringify({
      choices: [{ delta: { content: "hi" } }],
    });
    expect(wrapped.parseResponse(chunk)).toEqual([
      {
        type: "inference.text.delta",
        seq: 0,
        data: { token: "hi", partial: { text: "" }, index: 0 },
      },
    ]);
    expect(typeof wrapped.extractRetryAfterMs).toBe("function");
    expect(typeof wrapped.extractPacingDelayMs).toBe("function");
  });

  test("parseResponse salvages declared inline memory_search JSON into a tool call", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    wrapped.buildRequest(messages, "gpt-oss:20b", {
      tools: [memorySearchTool],
    });
    const events = [
      ...wrapped.parseResponse(
        JSON.stringify({
          choices: [{ delta: { content: CL_7186_PAYLOAD } }],
        }),
      ),
      ...wrapped.parseResponse(
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        }),
      ),
    ];
    expect(textDeltas(events)).toEqual([]);
    expect(toolStarts(events)[0]?.data.name).toBe("memory_search");
    expectSharedToolCallId(events);
    expect(JSON.parse(argumentFragments(events))).toEqual({
      query: "this person",
    });
  });

  test("parseJSONResponse salvages declared inline memory_search JSON into a tool call", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    wrapped.buildRequest(messages, "gpt-oss:20b", {
      tools: [memorySearchTool],
    });
    const events = wrapped.parseJSONResponse(
      JSON.stringify({
        object: "chat.completion",
        choices: [
          {
            message: { role: "assistant", content: CL_7186_PAYLOAD },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    expect(textDeltas(events)).toEqual([]);
    expect(toolStarts(events)[0]?.data.name).toBe("memory_search");
    expectSharedToolCallId(events);
    expect(JSON.parse(argumentFragments(events))).toEqual({
      query: "this person",
    });
  });

  test("every request asks the OpenAI-compat endpoint for a terminal usage chunk", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const body = bodyOf(wrapped.buildRequest(messages, "gpt-oss:20b", options));
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });

  test("parseResponse maps native prompt_eval_count/eval_count onto inference.usage", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const events = wrapped.parseResponse(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        prompt_eval_count: 42,
        eval_count: 17,
      }),
    );
    const usage = events.filter((event) => event.type === "inference.usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.data).toEqual({
      usage: {
        input: 42,
        output: 17,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      source,
    });
  });

  test("parseResponse does not double-emit usage when the OpenAI-shaped object is already present", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const events = wrapped.parseResponse(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
        prompt_eval_count: 99,
        eval_count: 99,
      }),
    );
    const usage = events.filter((event) => event.type === "inference.usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.data).toEqual({
      usage: {
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      source,
    });
  });

  test("reasoning rejects a thinking budget at or above max_tokens", () => {
    const wrapped = createOllamaAnthropicAdapter(source, {
      default: { reasoning: true },
    });
    expect(() =>
      wrapped.buildRequest(messages, "qwen3:8b", { maxTokens: 1024 }),
    ).toThrow("budget_tokens (1024) must be below max_tokens (1024)");
  });

  test("reasoning keeps a caller-requested thinking budget", () => {
    const wrapped = createOllamaAnthropicAdapter(source, {
      default: { reasoning: "high" },
    });
    const body = bodyOf(
      wrapped.buildRequest(messages, "qwen3:8b", {
        maxTokens: 8192,
        thinking: { enabled: true, budgetTokens: 4096 },
      }),
    );
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("buildRequest rejects a url-kind image_url", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const withUrlImage: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          {
            type: "image",
            source: {
              kind: "url",
              mimeType: "image/png",
              url: "https://example.com/cat.png",
            },
          },
        ],
      },
    ];
    expect(() =>
      wrapped.buildRequest(withUrlImage, "gpt-oss:20b", options),
    ).toThrow("https://example.com/cat.png");
  });

  test("buildRequest rejects a file-reference image", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const withFileRefImage: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          {
            type: "image",
            source: {
              kind: "file-reference",
              mimeType: "image/png",
              reference: "file_abc123",
            },
          },
        ],
      },
    ];
    expect(() =>
      wrapped.buildRequest(withFileRefImage, "gpt-oss:20b", options),
    ).toThrow(/@corbits\/ollama-adapter[\s\S]*file_abc123/);
  });

  test("buildRequest accepts a base64 image_url", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const withBase64Image: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          {
            type: "image",
            source: { kind: "base64", mimeType: "image/png", data: "Zm9v" },
          },
        ],
      },
    ];
    expect(() =>
      wrapped.buildRequest(withBase64Image, "gpt-oss:20b", options),
    ).not.toThrow();
  });
});

describe("createOllamaAnthropicAdapter", () => {
  test("buildRequest targets Anthropic /messages against a /v1 source base", () => {
    const wrapped = createOllamaAnthropicAdapter(source, undefined);
    const built = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    expect(built.url).toBe("/messages");
  });

  test("a /v1 source base concatenates to /v1/messages, not /v1/v1/messages", () => {
    const wrapped = createOllamaAnthropicAdapter(source, undefined);
    const built = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    const catalogBase = "http://localhost:11434/v1";
    const cloudBase = "https://ollama.com/v1";
    expect(resolveHarnessURL(built.url, catalogBase)).toBe(
      "http://localhost:11434/v1/messages",
    );
    expect(resolveHarnessURL(built.url, cloudBase)).toBe(
      "https://ollama.com/v1/messages",
    );
    expect(resolveHarnessURL(built.url, catalogBase)).not.toContain(
      "/v1/v1/messages",
    );
    expect(resolveHarnessURL(built.url, `${catalogBase}/`)).not.toContain(
      "/v1/v1/messages",
    );
  });

  test("buildRequest uses the Bearer credential sentinel, not x-api-key", () => {
    const wrapped = createOllamaAnthropicAdapter(source, undefined);
    const built = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    expect(built.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    expect(built.headers).not.toHaveProperty("x-api-key");
  });

  test("does not overlay OpenAI-compat num_ctx onto the Anthropic body", () => {
    const wrapped = createOllamaAnthropicAdapter(source, {
      default: { numCtx: 32768 },
    });
    const body = bodyOf(wrapped.buildRequest(messages, "gpt-oss:20b", options));
    expect(body).not.toHaveProperty("options");
  });

  test.each([
    [false, { type: "disabled" }],
    [true, { type: "enabled", budget_tokens: 1024 }],
    ["low", { type: "enabled", budget_tokens: 1024 }],
    ["max", { type: "enabled", budget_tokens: 1024 }],
  ] as const)("reasoning %p is sent as thinking %p", (reasoning, thinking) => {
    const wrapped = createOllamaAnthropicAdapter(source, {
      default: { reasoning },
    });
    const body = bodyOf(wrapped.buildRequest(messages, "qwen3:8b", options));
    expect(body["thinking"]).toEqual(thinking);
    expect(body).not.toHaveProperty("think");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("buildRequest rejects a url-kind image_url", () => {
    const wrapped = createOllamaAnthropicAdapter(source, undefined);
    const withUrlImage: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          {
            type: "image",
            source: {
              kind: "url",
              mimeType: "image/png",
              url: "https://example.com/cat.png",
            },
          },
        ],
      },
    ];
    expect(() =>
      wrapped.buildRequest(withUrlImage, "gpt-oss:20b", options),
    ).toThrow(/@corbits\/ollama-adapter[\s\S]*https:\/\/example.com\/cat.png/);
  });

  test("buildRequest rejects a file-reference image", () => {
    const wrapped = createOllamaAnthropicAdapter(source, undefined);
    const withFileRefImage: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          {
            type: "image",
            source: {
              kind: "file-reference",
              mimeType: "image/png",
              reference: "file_abc123",
            },
          },
        ],
      },
    ];
    expect(() =>
      wrapped.buildRequest(withFileRefImage, "gpt-oss:20b", options),
    ).toThrow(/@corbits\/ollama-adapter[\s\S]*file_abc123/);
  });

  test("buildRequest accepts a base64 image", () => {
    const wrapped = createOllamaAnthropicAdapter(source, undefined);
    const withBase64Image: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          {
            type: "image",
            source: { kind: "base64", mimeType: "image/png", data: "Zm9v" },
          },
        ],
      },
    ];
    expect(() =>
      wrapped.buildRequest(withBase64Image, "gpt-oss:20b", options),
    ).not.toThrow();
  });

  test("preserves the stock Anthropic adapter's response parser", () => {
    const wrapped = createOllamaAnthropicAdapter(source, undefined);
    expect(typeof wrapped.parseResponse).toBe("function");
    expect(typeof wrapped.parseJSONResponse).toBe("function");
  });
});
