import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@intx/inference";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type {
  ConversationTurn,
  InferenceEvent,
  InferenceOptions,
  LastCycleSource,
  ToolDefinition,
} from "@intx/types/runtime";

import {
  createOllamaAdapter,
  createOllamaAnthropicAdapter,
} from "../src/adapter";
import { OLLAMA_V1_BASE_URL, modelIsPulled } from "./helpers";

const MODEL = process.env["OLLAMA_MODEL"] ?? "gpt-oss:20b";
const TIMEOUT_MS = 120000;
const MAX_TOKENS = 2048;

const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

// An empty POST 400s on a present surface and 404s on a missing one
// without starting generation.
async function surfaceExists(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_V1_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1000),
    });
    await res.body?.cancel();
    return res.status !== 404;
  } catch {
    return false;
  }
}

const pulled = await modelIsPulled(MODEL);

function turn(text: string): ConversationTurn {
  return { role: "user", timestamp: 0, content: [{ type: "text", text }] };
}

async function stream(
  adapter: ProviderAdapter,
  text: string,
  options: InferenceOptions,
): Promise<InferenceEvent[]> {
  const built = adapter.buildRequest([turn(text)], MODEL, options);
  const headers = new Headers(built.headers);
  // Local Ollama ignores auth; never ship the literal sentinel.
  if (headers.get("authorization") === BEARER_CREDENTIAL_SENTINEL) {
    headers.set("authorization", "Bearer ollama");
  }
  const res = await fetch(`${OLLAMA_V1_BASE_URL}${built.url}`, {
    method: "POST",
    headers,
    body: built.body,
  });
  expect(res.status).toBe(200);
  if (res.body === null) throw new Error("expected a streamed body");

  const events: InferenceEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice("data: ".length).trim();
      if (data === "" || data === "[DONE]") continue;
      events.push(...adapter.parseResponse(data));
    }
  }
  return events;
}

function usageOf(events: InferenceEvent[]): { input: number; output: number } {
  const usage = events.find((event) => event.type === "inference.usage");
  if (usage === undefined) throw new Error("expected a usage event");
  return usage.data.usage;
}

function toolCallStartNames(events: InferenceEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "inference.tool_call.start" ? [event.data.name] : [],
  );
}

function countTextDeltas(events: InferenceEvent[]): number {
  return events.filter((event) => event.type === "inference.text.delta").length;
}

const factories = [
  {
    name: "createOllamaAdapter",
    create: createOllamaAdapter,
    path: "/chat/completions",
    provider: "ollama",
  },
  {
    name: "createOllamaAnthropicAdapter",
    create: createOllamaAnthropicAdapter,
    path: "/messages",
    provider: "anthropic",
  },
];

for (const factory of factories) {
  const source: LastCycleSource = {
    sourceId: `live/${factory.provider}`,
    provider: factory.provider,
    model: MODEL,
  };
  const reachable = pulled && (await surfaceExists(factory.path));

  describe.skipIf(!reachable)(`${factory.name} against Ollama`, () => {
    test(
      "a multi-line answer streams as several text deltas",
      async () => {
        const events = await stream(
          factory.create(source),
          "Count from one to five, one number per line.",
          { maxTokens: MAX_TOKENS },
        );
        expect(countTextDeltas(events)).toBeGreaterThan(1);
      },
      TIMEOUT_MS,
    );

    test.if(factory.provider === "anthropic")(
      "a thinking request is accepted and streams",
      async () => {
        const events = await stream(factory.create(source), "What is 2 + 2?", {
          maxTokens: MAX_TOKENS,
          thinking: { enabled: true, budgetTokens: 512 },
        });
        expect(events.length).toBeGreaterThan(0);
      },
      TIMEOUT_MS,
    );

    test.if(factory.provider === "ollama")(
      "maxOutputTokens caps the completion",
      async () => {
        const adapter = factory.create(source, {
          default: { maxOutputTokens: 16 },
        });
        const events = await stream(adapter, "Write a long story.", {
          maxTokens: MAX_TOKENS,
        });
        expect(usageOf(events).output).toBeLessThanOrEqual(16);
      },
      TIMEOUT_MS,
    );

    test(
      "a declared tool comes back as a tool call",
      async () => {
        const events = await stream(
          factory.create(source),
          "What is the weather in Boston? Use the get_weather tool.",
          { maxTokens: MAX_TOKENS, tools: [weatherTool] },
        );
        expect(toolCallStartNames(events)).toContain("get_weather");
      },
      TIMEOUT_MS,
    );
  });
}
