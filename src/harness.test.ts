import { afterEach, describe, expect, test } from "bun:test";
import { loadAdapterRegistry } from "@intx/inference/providers";
import {
  expectEvents,
  setupHarness,
  wire,
  type Harness,
} from "@intx/inference-testing";
import type { InferenceEvent, ToolDefinition } from "@intx/types/runtime";

import { createOllamaAdapter } from "./adapter";

const memorySearchTool: ToolDefinition = {
  name: "memory_search",
  description: "Search firm memory",
  inputSchema: { type: "object" },
};

const MEMORY_SEARCH_JSON =
  '{"name":"memory_search","parameters":{"query":"this person"}}';

const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a city",
  inputSchema: { type: "object" },
};

let harness: Harness | undefined;

function tokensOf(events: InferenceEvent[], type: InferenceEvent["type"]) {
  return events
    .flatMap((event) =>
      event.type === type &&
      (event.type === "inference.text.delta" ||
        event.type === "inference.thinking.delta")
        ? [event.data.token]
        : [],
    )
    .join("");
}

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

async function runTurn(
  contents: string[],
  tools: ToolDefinition[],
): Promise<InferenceEvent[]> {
  const current = setupHarness({
    adapters: await loadAdapterRegistry(
      [
        {
          provider: "ollama",
          specifier: "@corbits/ollama-adapter",
          export: "createOllamaAdapter",
        },
      ],
      { import: () => Promise.resolve({ createOllamaAdapter }) },
    ),
  });
  harness = current;
  for (const tool of tools) {
    current.scenario.onTool(tool.name, (args) => args);
  }
  const response = current.scenario.createStream();
  current.scenario.whenRequestMatches(() => true, response);
  const chunks = [
    ...contents.map((content) => wire.openai.chunk({ content })),
    wire.openai.chunk({ finishReason: "stop" }),
    wire.openai.done(),
  ];
  for (const [i, chunk] of chunks.entries()) {
    response.enqueueAt(i * 10, chunk);
  }
  response.closeAt(chunks.length * 10);

  let seq = 0;
  const events: InferenceEvent[] = [];
  const collect = (async () => {
    for await (const event of current.runInference({
      turns: [
        { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
      ],
      source: {
        id: "ollama:gpt-oss:20b",
        provider: "ollama",
        baseURL: "http://localhost:11434/v1",
        credentialId: "ollama",
        model: "gpt-oss:20b",
      },
      inferenceOptions: { tools },
      nextSeq: () => seq++,
    })) {
      events.push(event);
    }
  })();
  await current.run();
  await collect;
  return events;
}

describe("createOllamaAdapter through the inference harness", () => {
  test("a <think> span streams as thinking, then the answer as text", async () => {
    const events = await runTurn(
      ["<think>plan the", " approach</think>", "Here is the answer."],
      [],
    );
    expectEvents(events).toMatchSequence([
      { type: "inference.start" },
      { type: "inference.thinking.delta" },
      { type: "inference.text.delta" },
      { type: "inference.done" },
    ]);
    expect(tokensOf(events, "inference.thinking.delta")).toBe(
      "plan the approach",
    );
    expect(tokensOf(events, "inference.text.delta")).toBe(
      "Here is the answer.",
    );
  });

  test("inline tool JSON naming a declared tool becomes a tool call", async () => {
    const events = await runTurn(
      [MEMORY_SEARCH_JSON.slice(0, 20), MEMORY_SEARCH_JSON.slice(20)],
      [memorySearchTool],
    );
    expectEvents(events).toMatchSequence([
      { type: "inference.start" },
      {
        type: "inference.tool_call.start",
        data: { name: "memory_search" },
      },
      { type: "inference.done" },
    ]);
    expect(tokensOf(events, "inference.text.delta")).toBe("");
    expect(harness?.scenario.lastToolDispatch("memory_search")).toEqual({
      query: "this person",
    });
  });

  test("inline tool JSON naming an undeclared tool stays text", async () => {
    const events = await runTurn([MEMORY_SEARCH_JSON], [weatherTool]);
    expect(
      events.some((event) => event.type === "inference.tool_call.start"),
    ).toBe(false);
    expect(tokensOf(events, "inference.text.delta")).toBe(MEMORY_SEARCH_JSON);
  });
});
