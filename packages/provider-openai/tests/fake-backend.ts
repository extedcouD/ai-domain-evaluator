/**
 * Backends that lie, on demand.
 *
 * These are real `node:http` servers, not mocks, because the failures this harness exists to catch
 * are WIRE failures. A stubbed client would let us assert that we sent `response_format` — but the
 * bug is that a server accepts `response_format`, returns 200 with a perfectly-formed usage object,
 * and ignores it. You cannot reproduce that by stubbing the thing you're trying to catch lying.
 *
 * The servers RECORD what they were sent (`fake.requests`). Several tests can only be written that
 * way: "did the repair loop actually feed the validation error back, or did it just retry?" is a
 * question about the second request body, and nothing else can answer it.
 */
import { createServer, type Server } from "node:http";

import type { OpenAiConfig } from "../src/index";

export interface FakeSpec {
  /** Does `response_format` constrain the output, or get accepted and dropped on the floor? */
  schema?: "honors" | "ignores";
  /** Does `n: 3` return three different choices, one choice, or three identical ones? */
  n?: "honors" | "ignores" | "identical";
  /** Does the server emit `tool_calls`, or write a paragraph about wanting to? */
  tools?: "native" | "pretends";
  /** How the SSE stream behaves. */
  stream?: "chunks" | "no-usage" | "one-giant-chunk" | "hangs";
  /**
   * A hybrid-reasoning model. Emits `reasoning_content` before (or instead of) `content`.
   *
   * "all-budget" is the nasty one, and it is not invented: it is what LM Studio + Gemma actually does
   * at a low `maxTokens`. The model spends every token thinking, never reaches an answer, and the
   * server returns 200 with a full usage object and an empty string.
   */
  reasoning?: "none" | "then-answers" | "all-budget";
  /** Does `logprobs: true` come back with logprobs? */
  logprobs?: "honors" | "ignores";
  /** What a valid, schema-satisfying answer looks like for whatever schema the test is using. */
  validJson?: string;
  /** Milliseconds between streamed frames. Defaults to 0. */
  delayMs?: number;
}

export interface FakeBackend {
  server: Server;
  port: number;
  /** Every request body this server received, in order. */
  requests: Record<string, unknown>[];
  config(): OpenAiConfig;
  close(): void;
}

const DEFAULTS: Required<Pick<FakeSpec, "schema" | "n" | "tools" | "stream" | "logprobs" | "reasoning">> = {
  schema: "honors",
  n: "honors",
  tools: "native",
  stream: "chunks",
  logprobs: "honors",
  reasoning: "none",
};

const THOUGHT = "The user wants me to count. Let me think about that carefully.";

export async function fakeBackend(spec: FakeSpec = {}): Promise<FakeBackend> {
  const s = { ...DEFAULTS, ...spec };
  const requests: Record<string, unknown>[] = [];

  const server = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
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
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      apiKey: "not-needed",
      model: "fake-model",
      temperature: 0,
      topP: 1,
      maxTokens: 128,
      schemaMode: "json_schema",
    }),
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------------------------
// Non-streaming
// ---------------------------------------------------------------------------------------------

function respondJson(
  res: import("node:http").ServerResponse,
  s: Required<Pick<FakeSpec, "schema" | "n" | "tools" | "logprobs">> & FakeSpec,
  body: Record<string, unknown>,
): void {
  res.setHeader("content-type", "application/json");

  const wantsTools = Array.isArray(body["tools"]) && body["tools"].length > 0;
  const requested = typeof body["n"] === "number" ? body["n"] : 1;

  // A backend that HAS tools uses them. One that only pretends writes about them instead — and
  // returns 200, with a finish_reason of "stop", looking for all the world like it complied.
  if (wantsTools && s.tools === "native") {
    res.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        model: "fake-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "zzz_canary_tool", arguments: '{"value":7}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      }),
    );
    return;
  }

  // The model burned every token thinking and never reached an answer. 200 OK, full usage, no text.
  const starved = s.reasoning === "all-budget";
  const content = starved ? "" : bodyText(s, body);
  const count = s.n === "ignores" ? 1 : requested;
  const choices = Array.from({ length: count }, (_, i) => ({
    index: i,
    message: {
      role: "assistant",
      content: s.n === "identical" || i === 0 ? content : `${content} (variant ${String(i)})`,
      ...(s.reasoning === "none" ? {} : { reasoning_content: THOUGHT }),
    },
    finish_reason: starved ? "length" : "stop",
    ...(body["logprobs"] === true && s.logprobs === "honors"
      ? { logprobs: { content: [{ token: "x", logprob: -0.5 }] } }
      : {}),
  }));

  res.end(
    JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion",
      model: "fake-model",
      choices,
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }),
  );
}

/** What the assistant says. This is where "honors the schema" and "ignores it" diverge. */
function bodyText(s: FakeSpec, body: Record<string, unknown>): string {
  const constrained = body["response_format"] !== undefined || body["structured_outputs"] !== undefined;
  const wantsTools = Array.isArray(body["tools"]) && body["tools"].length > 0;

  if (wantsTools && s.tools === "pretends") {
    // The tell: it TALKS about the tool. 200 OK, finish_reason "stop", zero tool_calls.
    return "I would call zzz_canary_tool with the value 7 in order to answer that.";
  }

  if (!constrained) return "Canada is a country in North America.";

  if (s.schema === "ignores") {
    // The whole reason `probeSchemaEnforcement` exists. 200 OK. Perfect usage object. Pure prose.
    return "Canada is a country in North America.";
  }

  return s.validJson ?? '{"zzz_canary": 7}';
}

// ---------------------------------------------------------------------------------------------
// Streaming (real SSE)
// ---------------------------------------------------------------------------------------------

async function respondStream(
  res: import("node:http").ServerResponse,
  s: Required<Pick<FakeSpec, "schema" | "n" | "tools" | "stream">> & FakeSpec,
  body: Record<string, unknown>,
): Promise<void> {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");

  const pause = (): Promise<void> =>
    s.delayMs && s.delayMs > 0 ? new Promise((r) => setTimeout(r, s.delayMs)) : Promise.resolve();

  const frame = async (o: unknown): Promise<void> => {
    res.write(`data: ${JSON.stringify(o)}\n\n`);
    await pause();
  };
  const chunk = (choices: unknown[], usage?: unknown): unknown => ({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    model: "fake-model",
    choices,
    ...(usage ? { usage } : {}),
  });

  // Writes one frame, then never finishes. The ONLY way to test that an AbortSignal actually
  // cancels an in-flight stream rather than just being accepted and ignored.
  if (s.stream === "hangs") {
    await frame(chunk([{ index: 0, delta: { content: "start" }, finish_reason: null }]));
    return; // deliberately no end(), no [DONE]
  }

  const wantsTools = Array.isArray(body["tools"]) && body["tools"].length > 0;

  if (wantsTools && s.tools === "native") {
    // The arguments JSON is split MID-STRING across three frames. This is what real servers do, and
    // it is precisely why a caller must never JSON.parse a fragment: frame 2 alone is `{"loc`.
    await frame(
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }],
          },
          finish_reason: null,
        },
      ]),
    );
    for (const piece of ['{"loc', 'ation":"Par', 'is"}']) {
      await frame(
        chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }]),
      );
    }
    await frame(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
    await frame(chunk([], { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // Scratchpad tokens come FIRST, in a sibling field the OpenAI SDK does not type. On "all-budget"
  // they are the only tokens the model ever emits.
  if (s.reasoning !== "none") {
    for (const piece of splitIntoTokens(THOUGHT)) {
      await frame(chunk([{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }]));
    }
    if (s.reasoning === "all-budget") {
      await frame(chunk([{ index: 0, delta: {}, finish_reason: "length" }]));
      await frame(chunk([], { prompt_tokens: 5, completion_tokens: 64, total_tokens: 69 }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
  }

  const text = bodyText(s, body);

  if (s.stream === "one-giant-chunk") {
    // Technically streaming. Emits exactly one frame, so TTFT is meaningless and the UI just blinks.
    await frame(chunk([{ index: 0, delta: { content: text }, finish_reason: "stop" }]));
    await frame(chunk([], { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  for (const piece of splitIntoTokens(text)) {
    await frame(chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]));
  }
  await frame(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));

  // The heart of the "complete() is not sugar over stream()" argument: this server streams
  // perfectly, was ASKED for usage via stream_options, and simply does not implement it. No error,
  // no warning — the counts are just never sent, and a naive wrapper reports zero tokens forever.
  if (s.stream !== "no-usage") {
    await frame(chunk([], { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }));
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

/** Crude, but it produces many small frames, which is the property under test. */
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
