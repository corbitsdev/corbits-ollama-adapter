// CL-8354 spike: does Ollama's Anthropic-compatible `/v1/messages` endpoint
// work behind Interchange's stock, unmodified Anthropic adapter? This test
// drives `createAnthropicAdapter` from `@intx/inference/providers` directly
// against a local Ollama — no custom adapter code from this package is
// under test here. Findings are written up in README.md.
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "@intx/inference/providers";
import type {
  ConversationTurn,
  InferenceEvent,
  LastCycleSource,
  ToolDefinition,
} from "@intx/types/runtime";

const OLLAMA_BASE_URL = "http://localhost:11434";
const MODEL = "gpt-oss:20b";

const source: LastCycleSource = {
  sourceId: "spike/ollama-anthropic",
  provider: "anthropic",
  model: MODEL,
};

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await ollamaReachable();

function turn(text: string): ConversationTurn {
  return { role: "user", timestamp: 0, content: [{ type: "text", text }] };
}

async function runStreaming(
  messages: ConversationTurn[],
  opts: Parameters<
    ReturnType<typeof createAnthropicAdapter>["buildRequest"]
  >[2],
): Promise<{ status: number; events: InferenceEvent[]; raw: string[] }> {
  const adapter = createAnthropicAdapter(source);
  const built = adapter.buildRequest(messages, MODEL, opts);
  const headers = { ...built.headers };
  // Ollama does not check the Anthropic api-key header at all; the sentinel
  // is replaced with a harmless placeholder so the raw fetch below doesn't
  // ship the literal "<inject:credential>" marker string.
  headers["x-api-key"] = "ollama-does-not-check-this";
  const res = await fetch(`${OLLAMA_BASE_URL}${built.url}`, {
    method: "POST",
    headers,
    body: built.body,
  });

  const events: InferenceEvent[] = [];
  const raw: string[] = [];
  if (!res.ok || res.body === null) {
    return { status: res.status, events, raw };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice("data: ".length).trim();
      if (data === "" || data === "[DONE]") continue;
      raw.push(data);
      events.push(...adapter.parseResponse(data));
    }
  }
  return { status: res.status, events, raw };
}

describe.skipIf(!reachable)("stock Anthropic adapter against Ollama", () => {
  test("chat turn: plain text streams back", async () => {
    const { status, events } = await runStreaming(
      [turn("Say hi in one word.")],
      {},
    );
    expect(status).toBe(200);
    const textDeltas = events.filter((e) => e.type === "inference.text.delta");
    expect(textDeltas.length).toBeGreaterThan(0);
  }, 60000);

  test("streaming turn: multiple incremental text deltas arrive", async () => {
    const { status, events } = await runStreaming(
      [turn("Count from one to five, one number per line.")],
      {},
    );
    expect(status).toBe(200);
    const textDeltas = events.filter((e) => e.type === "inference.text.delta");
    // A genuinely streamed response arrives as more than one chunk for a
    // multi-line answer; a single-shot fake-stream would collapse to one.
    expect(textDeltas.length).toBeGreaterThan(1);
  }, 60000);

  test("tool call turn: model emits a native tool_use block", async () => {
    const tools: ToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get the current weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
    const { status, events } = await runStreaming(
      [turn("What is the weather in Boston? Use the get_weather tool.")],
      { tools },
    );
    expect(status).toBe(200);
    const starts = events.filter(
      (
        e,
      ): e is Extract<InferenceEvent, { type: "inference.tool_call.start" }> =>
        e.type === "inference.tool_call.start",
    );
    expect(starts.length).toBeGreaterThan(0);
    expect(starts[0]?.data.name).toBe("get_weather");
    const deltas = events.filter(
      (
        e,
      ): e is Extract<InferenceEvent, { type: "inference.tool_call.delta" }> =>
        e.type === "inference.tool_call.delta",
    );
    const args = deltas.map((e) => e.data.argumentFragment).join("");
    expect(() => JSON.parse(args)).not.toThrow();
  }, 60000);

  test("thinking turn: adapter's thinking request is at least accepted", async () => {
    const { status, events, raw } = await runStreaming(
      [turn("What is 17 * 24? Think step by step.")],
      { thinking: { enabled: true, budgetTokens: 512 } },
    );
    // Findings on whether Ollama actually populates thinking_delta (versus
    // just accepting the field and thinking silently, or 400ing) are
    // recorded in README.md — this assertion only pins that the request
    // is not rejected outright.
    expect(status).toBe(200);
    expect(raw.length).toBeGreaterThan(0);
    void events;
  }, 60000);
});

describe.skipIf(reachable)("stock Anthropic adapter against Ollama", () => {
  test("skipped: no local Ollama reachable at localhost:11434", () => {
    expect(true).toBe(true);
  });
});
