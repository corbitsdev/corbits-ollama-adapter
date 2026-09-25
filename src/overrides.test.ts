import { describe, expect, test } from "bun:test";
import {
  OllamaAdapterConfig,
  parseOllamaAdapterConfig,
  resolveOverride,
} from "./overrides";

describe("parseOllamaAdapterConfig", () => {
  test("undefined quirks resolve to an empty config", () => {
    expect(parseOllamaAdapterConfig(undefined)).toEqual({});
  });

  test("rejects an unknown top-level key", () => {
    expect(() => parseOllamaAdapterConfig({ bogus: true })).toThrow();
  });

  test("maps the pre-0.2.0 think and reasoningEffort keys to reasoning", () => {
    expect(
      parseOllamaAdapterConfig({
        default: { reasoningEffort: "high" },
        perModel: {
          a: { think: false },
          b: { think: "low", reasoningEffort: "high" },
          c: { think: true, reasoning: "max" },
        },
      }),
    ).toEqual({
      default: { reasoning: "high" },
      perModel: {
        a: { reasoning: false },
        b: { reasoning: "low" },
        c: { reasoning: "max" },
      },
    });
  });

  test("accepts a well-formed default and perModel config", () => {
    const parsed = OllamaAdapterConfig({
      default: { maxOutputTokens: 1024 },
      perModel: { "gpt-oss:20b": { maxOutputTokens: 2048 } },
    });
    expect(parsed instanceof Error).toBe(false);
  });
});

describe("resolveOverride", () => {
  test("no override configured resolves to an empty override", () => {
    expect(resolveOverride({}, "gpt-oss:20b")).toEqual({});
  });

  test("the general default applies when no per-model entry matches", () => {
    const config = parseOllamaAdapterConfig({
      default: { maxOutputTokens: 1024 },
    });
    expect(resolveOverride(config, "qwen3.8:27b")).toEqual({
      maxOutputTokens: 1024,
    });
  });

  test("a per-model override beats the general default field-by-field", () => {
    const config = parseOllamaAdapterConfig({
      default: { maxOutputTokens: 1024, reasoning: "low" },
      perModel: { "gpt-oss:20b": { reasoning: "high" } },
    });
    expect(resolveOverride(config, "gpt-oss:20b")).toEqual({
      maxOutputTokens: 1024,
      reasoning: "high",
    });
    expect(resolveOverride(config, "qwen3.8:27b")).toEqual({
      maxOutputTokens: 1024,
      reasoning: "low",
    });
  });
});
