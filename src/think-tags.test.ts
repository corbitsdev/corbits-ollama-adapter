import { describe, expect, test } from "bun:test";
import type { InferenceEvent } from "@intx/types/runtime";

import { createThinkSplitState, reclassifyThinkingEvents } from "./think-tags";

function textDelta(token: string, seq = 1): InferenceEvent {
  return {
    type: "inference.text.delta",
    seq,
    data: { token, partial: { text: token }, index: 0 },
  };
}

function isThinkingDelta(
  event: InferenceEvent,
): event is Extract<InferenceEvent, { type: "inference.thinking.delta" }> {
  return event.type === "inference.thinking.delta";
}

function isTextDelta(
  event: InferenceEvent,
): event is Extract<InferenceEvent, { type: "inference.text.delta" }> {
  return event.type === "inference.text.delta";
}

function requireThinkingDelta(
  event: InferenceEvent | undefined,
): Extract<InferenceEvent, { type: "inference.thinking.delta" }> {
  if (!event || !isThinkingDelta(event)) {
    throw new Error(
      `expected inference.thinking.delta, got ${event?.type ?? "undefined"}`,
    );
  }
  return event;
}

function requireTextDelta(
  event: InferenceEvent | undefined,
): Extract<InferenceEvent, { type: "inference.text.delta" }> {
  if (!event || !isTextDelta(event)) {
    throw new Error(
      `expected inference.text.delta, got ${event?.type ?? "undefined"}`,
    );
  }
  return event;
}

describe("reclassifyThinkingEvents", () => {
  test("a whole <think>...</think> span in one token becomes thinking-delta, not text-delta", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents(
      [textDelta("<think>plan the approach</think>Here is the answer.")],
      state,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe("inference.thinking.delta");
    expect(requireThinkingDelta(out[0]).data.token).toBe("plan the approach");
    expect(out[1]?.type).toBe("inference.text.delta");
    expect(requireTextDelta(out[1]).data.token).toBe("Here is the answer.");
  });

  test("a <think> span split across multiple chunks stays classified as thinking across the boundary", () => {
    const state = createThinkSplitState();
    const first = reclassifyThinkingEvents(
      [textDelta("<think>step one, ")],
      state,
    );
    const second = reclassifyThinkingEvents(
      [textDelta("step two</think>final reply")],
      state,
    );

    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe("inference.thinking.delta");
    expect(second).toHaveLength(2);
    expect(second[0]?.type).toBe("inference.thinking.delta");
    expect(requireThinkingDelta(second[0]).data.token).toBe("step two");
    expect(second[1]?.type).toBe("inference.text.delta");
    expect(requireTextDelta(second[1]).data.token).toBe("final reply");
  });

  test("ordinary text with no <think> tag passes through as text-delta unchanged", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents(
      [textDelta("just a normal reply")],
      state,
    );
    expect(out).toEqual([textDelta("just a normal reply")]);
  });

  test("non-text events (tool calls, done) pass through untouched", () => {
    const state = createThinkSplitState();
    const toolCallStart: InferenceEvent = {
      type: "inference.tool_call.start",
      seq: 1,
      data: {
        callId: "call-1",
        name: "slack__post_message",
        partial: { text: "" },
      },
    };
    const out = reclassifyThinkingEvents([toolCallStart], state);
    expect(out).toEqual([toolCallStart]);
  });

  test("thinking events never share an index with the text stream, so the harness's per-index blockMap can't collide them", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents(
      [textDelta("<think>internal notes</think>visible reply", 3)],
      state,
    );
    const thinkingEvent = out.find(isThinkingDelta);
    const textEvent = out.find(isTextDelta);
    expect(thinkingEvent?.data.index).not.toBe(textEvent?.data.index);
    expect(textEvent?.data.index).toBe(0);
  });

  test("cumulative partial.text/partial.thinking reflect only their own kind, never the raw tags", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents(
      [textDelta("<think>internal notes</think>visible reply")],
      state,
    );
    const thinkingEvent = out.find(isThinkingDelta);
    const textEvent = out.find(isTextDelta);
    expect(thinkingEvent?.data.partial.thinking).toBe("internal notes");
    expect(textEvent?.data.partial.text).toBe("visible reply");
    expect(textEvent?.data.partial.text).not.toContain("<think>");
  });

  test("once a native thinking.delta has been seen, text deltas pass through without tag-splitting", () => {
    const state = createThinkSplitState();
    const nativeThinking: InferenceEvent = {
      type: "inference.thinking.delta",
      seq: 1,
      data: {
        token: "reasoning from the reasoning field",
        partial: { text: "" },
        index: -1,
      },
    };
    const first = reclassifyThinkingEvents([nativeThinking], state);
    expect(first).toEqual([nativeThinking]);

    // A literal "<think>" appearing in ordinary content after the model
    // already reported reasoning natively must not be mistaken for a tag
    // span — the native path already carried the real reasoning.
    const coincidental = textDelta("here is <think>literally in the reply");
    const second = reclassifyThinkingEvents([coincidental], state);
    expect(second).toEqual([coincidental]);
  });

  test("an open think span does not leak leftover tags once a native thinking.delta arrives", () => {
    const state = createThinkSplitState();
    const opened = reclassifyThinkingEvents(
      [textDelta("<think>partial")],
      state,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]?.type).toBe("inference.thinking.delta");

    const nativeThinking: InferenceEvent = {
      type: "inference.thinking.delta",
      seq: 2,
      data: {
        token: "reasoning from the reasoning field",
        partial: { text: "" },
        index: -1,
      },
    };
    reclassifyThinkingEvents([nativeThinking], state);

    const after = reclassifyThinkingEvents(
      [textDelta(" leftover</think>visible")],
      state,
    );
    const tokens = after.map(
      (event) => (event.data as { token: string }).token,
    );
    expect(tokens.join("")).not.toContain("<think>");
    expect(tokens.join("")).not.toContain("</think>");
    const textEvent = after.find(
      (event) => event.type === "inference.text.delta",
    );
    expect((textEvent?.data as { token: string }).token).toBe("visible");
  });
});
