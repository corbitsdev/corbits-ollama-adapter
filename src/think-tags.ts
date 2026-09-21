// Some Ollama models populate the `reasoning`/`reasoning_content` delta
// fields `@intx/inference`'s OpenAI provider already classifies as
// `inference.thinking.delta` (see `providers/openai.js`'s
// `reasoningFieldNames` handling) — typically when `think` is set on the
// request. Other models still emit chain-of-thought inline in `content`,
// wrapped in `<think>…</think>`. Left alone, that tagged text is
// indistinguishable from the reply and rides every hop downstream as a
// genuine `inference.text.delta` leak. This module reclassifies inline
// tags into `inference.thinking.delta` as a fallback, at the one place
// that already knows these tokens came from Ollama. Once a native
// thinking field has been seen for a response, tag-splitting stops so a
// coincidental literal "<think>" in ordinary text cannot be mistaken for
// a span — except an already-open tag span is still closed so leftover
// `</think>` cannot leak as text.
import type { InferenceEvent } from "@intx/types/runtime";

/** Carries the split state across every chunk of one streamed response —
 * a `<think>` tag can land at a chunk boundary, so "are we inside a
 * thinking span" has to survive from one `parseResponse` call to the next. */
export type ThinkSplitState = {
  inThink: boolean;
  /** Once a `<think>` tag has appeared at all, every later text-delta gets
   * its `partial` recomputed from this module's own tally rather than the
   * built-in adapter's — otherwise a token after the closing tag would
   * still carry the raw-tagged cumulative text the built-in parser tracked
   * on its own. Before the first tag, events pass through byte-identical. */
  everInThink: boolean;
  textAcc: string;
  thinkingAcc: string;
  /** Set once the built-in OpenAI adapter has already emitted a native
   * `inference.thinking.delta` for this response (it reads `reasoning`/
   * `reasoning_content` fields itself — see `providers/openai.js`'s
   * `reasoningFieldNames` handling). A model given a `think` override
   * (see overrides.ts) returns its reasoning that way, with no `<think>`
   * tags anywhere in `content`; regex-splitting `content` on top of an
   * already-classified native thinking stream is unnecessary and risks
   * misfiring on a coincidental literal "<think>" in ordinary text. The
   * tag splitter still runs as-is for a model that ignores `think` and
   * falls back to inline tags. */
  nativeThinkingSeen: boolean;
};

export function createThinkSplitState(): ThinkSplitState {
  return {
    inThink: false,
    everInThink: false,
    textAcc: "",
    thinkingAcc: "",
    nativeThinkingSeen: false,
  };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** The harness (`@intx/inference`'s `dist/harness.js`) keys its per-index
 * `blockMap` by `event.data.index` and throws a `ProtocolMismatchError` the
 * moment two different block kinds land at the same index — so the
 * thinking half of a split can never reuse the text index the built-in
 * OpenAI adapter already assigned to Ollama's one undifferentiated content
 * stream. Ollama's own indexer starts at 0 and only counts up (one index
 * per real block: text, then any tool calls), so a fixed negative
 * sentinel is guaranteed to never collide with one it hands out. */
const THINKING_BLOCK_INDEX = -1;

type TokenSplit = {
  readonly textToken: string;
  readonly thinkingToken: string;
};

/** Peels `<think>`/`</think>` spans out of one token, folding the result
 * into the running cumulative text/thinking strings. A tag never splits
 * across two tokens in practice, but a token straddling the tag boundary
 * (open and content in the same token, or close and content) is still
 * handled correctly by looping until the whole token is consumed. */
function splitToken(state: ThinkSplitState, token: string): TokenSplit {
  let remaining = token;
  let textToken = "";
  let thinkingToken = "";

  while (remaining.length > 0) {
    if (!state.inThink) {
      const openIndex = remaining.indexOf(THINK_OPEN);
      if (openIndex === -1) {
        textToken += remaining;
        break;
      }
      textToken += remaining.slice(0, openIndex);
      remaining = remaining.slice(openIndex + THINK_OPEN.length);
      state.inThink = true;
    } else {
      const closeIndex = remaining.indexOf(THINK_CLOSE);
      if (closeIndex === -1) {
        thinkingToken += remaining;
        break;
      }
      thinkingToken += remaining.slice(0, closeIndex);
      remaining = remaining.slice(closeIndex + THINK_CLOSE.length);
      state.inThink = false;
    }
  }

  state.textAcc += textToken;
  state.thinkingAcc += thinkingToken;
  return { textToken, thinkingToken };
}

/**
 * Rewrites one `parseResponse`/`parseJSONResponse` result so a
 * `<think>…</think>` span in an `inference.text.delta`'s token becomes an
 * `inference.thinking.delta` instead — every other event (tool calls,
 * usage, `inference.done`, ...) passes through untouched. `state` is
 * mutated in place so a caller threads the same instance across every
 * chunk of one response.
 */
export function reclassifyThinkingEvents(
  events: readonly InferenceEvent[],
  state: ThinkSplitState,
): InferenceEvent[] {
  const output: InferenceEvent[] = [];

  for (const event of events) {
    if (event.type === "inference.thinking.delta") {
      state.nativeThinkingSeen = true;
      output.push(event);
      continue;
    }

    if (event.type !== "inference.text.delta") {
      output.push(event);
      continue;
    }

    if (state.nativeThinkingSeen && !state.inThink) {
      output.push(event);
      continue;
    }

    const token = event.data.token;
    if (!state.inThink && !state.everInThink && !token.includes(THINK_OPEN)) {
      output.push(event);
      continue;
    }
    state.everInThink = true;

    const { textToken, thinkingToken } = splitToken(state, token);
    const partial = {
      text: state.textAcc,
      ...(state.thinkingAcc !== "" ? { thinking: state.thinkingAcc } : {}),
    };

    if (thinkingToken !== "") {
      output.push({
        type: "inference.thinking.delta",
        seq: event.seq,
        data: {
          token: thinkingToken,
          partial,
          index: THINKING_BLOCK_INDEX,
        },
      });
    }
    if (textToken !== "") {
      output.push({
        type: "inference.text.delta",
        seq: event.seq,
        data: {
          token: textToken,
          partial,
          ...(event.data.index !== undefined
            ? { index: event.data.index }
            : {}),
        },
      });
    }
  }

  return output;
}
