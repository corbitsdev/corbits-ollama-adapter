// Live check that each factory's `reasoning` wire field is honored by an
// Ollama server: on turns reasoning output on, off turns it off. Skips when
// OLLAMA_BASE_URL is unset or the model is not available there.
// OLLAMA_REASONING_MODEL picks another model.
import { describe, expect, test } from "bun:test";
import type { AdapterFactory, BuiltRequest } from "@intx/inference";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";

import {
  createOllamaAdapter,
  createOllamaAnthropicAdapter,
} from "../src/adapter";
import type { Reasoning } from "../src/overrides";

const OLLAMA_ROOT_URL = process.env["OLLAMA_BASE_URL"] ?? "";
const OLLAMA_V1_BASE_URL = `${OLLAMA_ROOT_URL}/v1`;
const MODEL = process.env["OLLAMA_REASONING_MODEL"] ?? "qwen3:8b";

const source: LastCycleSource = {
  sourceId: "ollama-live",
  provider: "ollama",
  model: MODEL,
};

const messages: ConversationTurn[] = [
  { role: "user", timestamp: 0, content: [{ type: "text", text: "2+2?" }] },
];

async function modelAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_ROOT_URL}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    return JSON.stringify(await res.json()).includes(`"name":"${MODEL}"`);
  } catch {
    return false;
  }
}

const reachable = OLLAMA_ROOT_URL !== "" && (await modelAvailable());
// gpt-oss only has low/medium/high effort; it cannot turn reasoning off.
const canDisableReasoning = !MODEL.startsWith("gpt-oss");

async function send(
  factory: AdapterFactory,
  reasoning: Reasoning,
): Promise<string> {
  const adapter = factory(source, { default: { reasoning } });
  const built: BuiltRequest = adapter.buildRequest(messages, MODEL, {
    maxTokens: 2048,
  });
  const body: unknown = JSON.parse(built.body);
  if (typeof body !== "object" || body === null) throw new Error("bad body");
  Reflect.set(body, "stream", false);
  const res = await fetch(`${OLLAMA_V1_BASE_URL}${built.url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe.skipIf(!reachable)(`reasoning against Ollama ${MODEL}`, () => {
  test.skipIf(!canDisableReasoning)(
    "OpenAI-compat: reasoning false suppresses reasoning output",
    async () => {
      expect(await send(createOllamaAdapter, false)).not.toContain(
        '"reasoning":',
      );
    },
    120000,
  );

  test("OpenAI-compat: reasoning high produces reasoning output", async () => {
    expect(await send(createOllamaAdapter, "high")).toContain('"reasoning":');
  }, 120000);

  test.skipIf(!canDisableReasoning)(
    "messages: reasoning false suppresses thinking blocks",
    async () => {
      expect(await send(createOllamaAnthropicAdapter, false)).not.toContain(
        '"type":"thinking"',
      );
    },
    120000,
  );

  test("messages: reasoning true produces thinking blocks", async () => {
    expect(await send(createOllamaAnthropicAdapter, true)).toContain(
      '"type":"thinking"',
    );
  }, 120000);
});
