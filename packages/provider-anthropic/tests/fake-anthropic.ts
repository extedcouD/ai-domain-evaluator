/**
 * A fake Anthropic Messages API that lies on demand.
 *
 * Same doctrine as the OpenAI fake: a real `node:http` server, not a mock, because the failure this
 * harness exists to catch is a WIRE behaviour. Here the Anthropic-specific shapes are emulated — a
 * top-level `system`, `tool_use`/`thinking` content blocks, the SSE event model, and structured
 * output enforced by a forced tool call — so the adapter's mapping is exercised end to end.
 *
 * The `schema: "ignores"` mode simulates a backend that was told to force a tool and answered in prose
 * anyway, which is how the adapter's probe learns whether structure is actually enforced.
 */
import { createServer, type Server } from "node:http";

import type { AnthropicConfig } from "../src/index";

export interface FakeAnthropicSpec {
  /** Does a forced tool call return the structured tool, or ignore it and answer in prose? */
  schema?: "honors" | "ignores";
  /** Emit `thinking` content blocks; "all-budget" thinks until max_tokens and never answers. */
  reasoning?: "none" | "then-answers" | "all-budget";
  /** Streaming behaviour. "hangs" writes one frame then never ends — the abort test. */
  stream?: "chunks" | "hangs";
  /** The JSON a forced structured tool returns as its `input`. */
  validJson?: string;
  delayMs?: number;
}

export interface FakeAnthropic {
  server: Server;
  port: number;
  requests: Record<string, unknown>[];
  config(): AnthropicConfig;
  close(): void;
}

const DEFAULTS: Required<Pick<FakeAnthropicSpec, "schema" | "reasoning" | "stream">> = {
  schema: "honors",
  reasoning: "none",
  stream: "chunks",
};

const THOUGHT = "The user wants me to count. Let me think about that carefully.";
const PROSE = "Canada is a country in North America.";

/** Read the routing-relevant fields off a raw request body (everything on the wire is `unknown`). */
function readRouting(body: Record<string, unknown>): { forced: boolean; toolName: string; wantsTools: boolean } {
  const toolChoice = body["tool_choice"] as { type?: string; name?: string } | undefined;
  const tools = body["tools"] as { name?: string }[] | undefined;
  return {
    forced: toolChoice?.type === "tool",
    toolName: toolChoice?.name ?? tools?.[0]?.name ?? "respond",
    wantsTools: Array.isArray(tools) && tools.length > 0,
  };
}

export async function fakeAnthropic(spec: FakeAnthropicSpec = {}): Promise<FakeAnthropic> {
  const s = { ...DEFAULTS, ...spec };
  const requests: Record<string, unknown>[] = [];

  const server = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ type: "model", id: "fake-claude", display_name: "Fake Claude", created_at: "2024-01-01T00:00:00Z" }],
          has_more: false,
          first_id: "fake-claude",
          last_id: "fake-claude",
        }),
      );
      return;
    }

    let raw = "";
    req.on("data", (c) => (raw += c as string));
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      requests.push(body);
      if (body["stream"] === true) {
        void respondStream(res, s, body);
      } else {
        respondJson(res, s, body);
      }
    });
  });

  const port = await listen(server);

  return {
    server,
    port,
    requests,
    config: () => ({
      // The Anthropic SDK appends `/v1/messages`; give it a bare origin.
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: "not-needed",
      model: "fake-claude",
      temperature: 0,
      topP: 1,
      maxTokens: 128,
    }),
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------------------------
// Non-streaming
// ---------------------------------------------------------------------------------------------

function respondJson(res: import("node:http").ServerResponse, s: FakeAnthropicSpec, body: Record<string, unknown>): void {
  res.setHeader("content-type", "application/json");

  const { forced, toolName, wantsTools } = readRouting(body);

  let content: unknown[];
  let stop_reason: string;

  if (s.reasoning === "all-budget") {
    content = [{ type: "thinking", thinking: THOUGHT, signature: "" }];
    stop_reason = "max_tokens";
  } else if (forced && s.schema === "honors") {
    const input = JSON.parse(s.validJson ?? '{"zzz_canary":7}') as Record<string, unknown>;
    content = [{ type: "tool_use", id: "toolu_1", name: toolName, input }];
    stop_reason = "tool_use";
  } else if (forced && s.schema === "ignores") {
    content = [{ type: "text", text: PROSE }];
    stop_reason = "end_turn";
  } else if (wantsTools) {
    content = [{ type: "tool_use", id: "toolu_1", name: toolName, input: { location: "Paris" } }];
    stop_reason = "tool_use";
  } else {
    content = [
      ...(s.reasoning === "then-answers" ? [{ type: "thinking", thinking: THOUGHT, signature: "" }] : []),
      { type: "text", text: PROSE },
    ];
    stop_reason = "end_turn";
  }

  res.end(
    JSON.stringify({
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "fake-claude",
      content,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 6 },
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Streaming (Anthropic SSE)
// ---------------------------------------------------------------------------------------------

async function respondStream(
  res: import("node:http").ServerResponse,
  s: FakeAnthropicSpec,
  body: Record<string, unknown>,
): Promise<void> {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");

  const pause = (): Promise<void> =>
    s.delayMs && s.delayMs > 0 ? new Promise((r) => setTimeout(r, s.delayMs)) : Promise.resolve();
  const sse = async (event: string, data: unknown): Promise<void> => {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`);
    await pause();
  };

  await sse("message_start", {
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "fake-claude",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  });

  // One frame, then hang forever — the ONLY way to prove an AbortSignal truly cancels an in-flight
  // stream rather than being accepted and ignored.
  if (s.stream === "hangs") {
    await sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    await sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "start" } });
    return; // deliberately no message_stop
  }

  const { forced, toolName, wantsTools } = readRouting(body);

  if (s.reasoning === "all-budget") {
    await sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } });
    for (const piece of splitIntoTokens(THOUGHT)) {
      await sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: piece } });
    }
    await sse("content_block_stop", { index: 0 });
    await sse("message_delta", { delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 64 } });
    await sse("message_stop", {});
    res.end();
    return;
  }

  if (forced && s.schema === "honors") {
    const json = s.validJson ?? '{"zzz_canary":7}';
    await sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: toolName, input: {} } });
    for (const piece of splitIntoTokens(json)) {
      await sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: piece } });
    }
    await sse("content_block_stop", { index: 0 });
    await sse("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 6 } });
    await sse("message_stop", {});
    res.end();
    return;
  }

  if (wantsTools && !forced) {
    await sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: toolName, input: {} } });
    // Arguments split mid-string across frames, exactly as a real server does.
    for (const piece of ['{"loc', 'ation":"Par', 'is"}']) {
      await sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: piece } });
    }
    await sse("content_block_stop", { index: 0 });
    await sse("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 6 } });
    await sse("message_stop", {});
    res.end();
    return;
  }

  // Ordinary answer, optionally with a thinking block first.
  if (s.reasoning === "then-answers") {
    await sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } });
    for (const piece of splitIntoTokens(THOUGHT)) {
      await sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: piece } });
    }
    await sse("content_block_stop", { index: 0 });
  }
  await sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
  for (const piece of splitIntoTokens(PROSE)) {
    await sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: piece } });
  }
  await sse("content_block_stop", { index: 1 });
  await sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } });
  await sse("message_stop", {});
  res.end();
}

function splitIntoTokens(text: string): string[] {
  return text.match(/.{1,4}/g) ?? [text];
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}
