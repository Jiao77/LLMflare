type JsonObject = Record<string, unknown>;

interface SseFrame {
  event?: string;
  data: string;
}

interface SseMapper {
  frame(frame: SseFrame): string[];
  end(): string[];
}

interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

const encoder = new TextEncoder();
const MAX_COMPLETED_TEXT = 2_000_000;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? value as JsonObject : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

class SseParser {
  private buffer = "";

  push(text: string, flush = false): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    let match: RegExpExecArray | null;
    const boundary = /\r?\n\r?\n/;
    while ((match = boundary.exec(this.buffer))) {
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = this.parse(raw);
      if (frame) frames.push(frame);
    }
    if (flush && this.buffer.trim()) {
      const frame = this.parse(this.buffer);
      if (frame) frames.push(frame);
      this.buffer = "";
    }
    return frames;
  }

  private parse(raw: string): SseFrame | null {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  }
}

function transformedSse(upstream: Response, mapper: SseMapper): Response {
  if (!upstream.ok || !upstream.body) return upstream;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const pending: Uint8Array[] = [];
  let sourceEnded = false;

  const append = (items: string[]) => {
    for (const item of items) if (item) pending.push(encoder.encode(item));
  };
  const consume = (frames: SseFrame[]) => {
    for (const frame of frames) append(mapper.frame(frame));
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!pending.length && !sourceEnded) {
          const result = await reader.read();
          if (result.done) {
            consume(parser.push(decoder.decode(), true));
            append(mapper.end());
            sourceEnded = true;
            break;
          }
          consume(parser.push(decoder.decode(result.value, { stream: true })));
        }
        const next = pending.shift();
        if (next) controller.enqueue(next);
        else if (sourceEnded) controller.close();
      } catch (cause) {
        try { await reader.cancel(cause); } catch { /* Preserve the original stream error. */ }
        controller.error(cause);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  const headers = new Headers(upstream.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function openAIUsage(payload: JsonObject): TokenUsage {
  const usage = object(payload.usage) || {};
  const input = number(usage.prompt_tokens ?? usage.input_tokens);
  const output = number(usage.completion_tokens ?? usage.output_tokens);
  return { input, output, total: number(usage.total_tokens) || input + output };
}

function stopReason(value: unknown): string {
  if (value === "length") return "max_tokens";
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "content_filter") return "refusal";
  return "end_turn";
}

class ChatToMessagesMapper implements SseMapper {
  private readonly fallbackId = `msg_${crypto.randomUUID()}`;
  private started = false;
  private finalized = false;
  private nextBlock = 0;
  private textBlock: number | null = null;
  private readonly openBlocks = new Set<number>();
  private readonly tools = new Map<number, { block: number; id: string; name: string; started: boolean }>();
  private finishReason: unknown = null;
  private usage: TokenUsage = { input: 0, output: 0, total: 0 };
  private id = this.fallbackId;

  constructor(private readonly model: string) {}

  private start(payload?: JsonObject): string[] {
    if (this.started) return [];
    this.started = true;
    if (typeof payload?.id === "string") this.id = payload.id.replace(/^chat/, "msg");
    const model = typeof payload?.model === "string" ? payload.model : this.model;
    return [sse("message_start", {
      type: "message_start",
      message: { id: this.id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    })];
  }

  private text(text: string, payload: JsonObject): string[] {
    const output = this.start(payload);
    if (this.textBlock === null) {
      this.textBlock = this.nextBlock++;
      this.openBlocks.add(this.textBlock);
      output.push(sse("content_block_start", { type: "content_block_start", index: this.textBlock, content_block: { type: "text", text: "" } }));
    }
    output.push(sse("content_block_delta", { type: "content_block_delta", index: this.textBlock, delta: { type: "text_delta", text } }));
    return output;
  }

  private tool(delta: JsonObject, toolIndex: number, payload: JsonObject): string[] {
    const output = this.start(payload);
    const fn = object(delta.function) || {};
    let state = this.tools.get(toolIndex);
    if (!state) {
      state = {
        block: this.nextBlock++,
        id: typeof delta.id === "string" ? delta.id : `toolu_${crypto.randomUUID()}`,
        name: typeof fn.name === "string" ? fn.name : "tool",
        started: false,
      };
      this.tools.set(toolIndex, state);
    } else {
      if (typeof delta.id === "string") state.id = delta.id;
      if (typeof fn.name === "string") state.name = fn.name;
    }
    if (!state.started) {
      state.started = true;
      this.openBlocks.add(state.block);
      output.push(sse("content_block_start", { type: "content_block_start", index: state.block, content_block: { type: "tool_use", id: state.id, name: state.name, input: {} } }));
    }
    if (typeof fn.arguments === "string" && fn.arguments) {
      output.push(sse("content_block_delta", { type: "content_block_delta", index: state.block, delta: { type: "input_json_delta", partial_json: fn.arguments } }));
    }
    return output;
  }

  private finish(): string[] {
    if (this.finalized) return [];
    this.finalized = true;
    const output = this.start();
    for (const index of [...this.openBlocks].sort((a, b) => a - b)) output.push(sse("content_block_stop", { type: "content_block_stop", index }));
    output.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason(this.finishReason), stop_sequence: null },
      usage: { input_tokens: this.usage.input, output_tokens: this.usage.output },
    }));
    output.push(sse("message_stop", { type: "message_stop" }));
    return output;
  }

  frame(frame: SseFrame): string[] {
    if (frame.data === "[DONE]") return this.finish();
    let payload: JsonObject;
    try { payload = JSON.parse(frame.data) as JsonObject; }
    catch { return []; }
    if (payload.error) {
      this.finalized = true;
      return [sse("error", { type: "error", error: payload.error })];
    }
    const usage = openAIUsage(payload);
    if (usage.input || usage.output || usage.total) this.usage = usage;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const output: string[] = [];
    for (const rawChoice of choices) {
      const choice = object(rawChoice);
      if (!choice) continue;
      const delta = object(choice.delta) || {};
      if (typeof delta.content === "string" && delta.content) output.push(...this.text(delta.content, payload));
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawTool of toolCalls) {
        const tool = object(rawTool);
        if (tool) output.push(...this.tool(tool, number(tool.index), payload));
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) this.finishReason = choice.finish_reason;
    }
    if (!this.started && choices.length) output.push(...this.start(payload));
    return output;
  }

  end(): string[] {
    return this.finish();
  }
}

interface ResponseToolState {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  started: boolean;
}

class ChatToResponsesMapper implements SseMapper {
  private readonly fallbackId = `resp_${crypto.randomUUID()}`;
  private readonly messageItemId = `msg_${crypto.randomUUID()}`;
  private id = this.fallbackId;
  private model: string;
  private created = false;
  private finalized = false;
  private textStarted = false;
  private text = "";
  private textTruncated = false;
  private nextOutputIndex = 0;
  private messageOutputIndex = -1;
  private readonly tools = new Map<number, ResponseToolState>();
  private finishReason: unknown = null;
  private usage: TokenUsage = { input: 0, output: 0, total: 0 };
  private sequence = 0;

  constructor(model: string) { this.model = model; }

  private response(status: string, output: unknown[] = []): JsonObject {
    return { id: this.id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model: this.model, output, usage: { input_tokens: this.usage.input, output_tokens: this.usage.output, total_tokens: this.usage.total } };
  }

  private event(type: string, payload: JsonObject): string {
    return sse(type, { type, ...payload, sequence_number: this.sequence++ });
  }

  private start(payload?: JsonObject): string[] {
    if (this.created) return [];
    this.created = true;
    if (typeof payload?.id === "string") this.id = payload.id.replace(/^chat/, "resp");
    if (typeof payload?.model === "string") this.model = payload.model;
    return [
      this.event("response.created", { response: this.response("queued") }),
      this.event("response.in_progress", { response: this.response("in_progress") }),
    ];
  }

  private appendText(text: string, payload: JsonObject): string[] {
    const output = this.start(payload);
    if (!this.textStarted) {
      this.textStarted = true;
      this.messageOutputIndex = this.nextOutputIndex++;
      output.push(this.event("response.output_item.added", { output_index: this.messageOutputIndex, item: { id: this.messageItemId, type: "message", status: "in_progress", role: "assistant", content: [] } }));
      output.push(this.event("response.content_part.added", { item_id: this.messageItemId, output_index: this.messageOutputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    }
    if (!this.textTruncated) {
      if (this.text.length + text.length <= MAX_COMPLETED_TEXT) this.text += text;
      else this.textTruncated = true;
    }
    output.push(this.event("response.output_text.delta", { item_id: this.messageItemId, output_index: this.messageOutputIndex, content_index: 0, delta: text }));
    return output;
  }

  private appendTool(delta: JsonObject, toolIndex: number, payload: JsonObject): string[] {
    const output = this.start(payload);
    const fn = object(delta.function) || {};
    let state = this.tools.get(toolIndex);
    if (!state) {
      const callId = typeof delta.id === "string" ? delta.id : `call_${crypto.randomUUID()}`;
      state = { outputIndex: this.nextOutputIndex++, itemId: `fc_${crypto.randomUUID()}`, callId, name: typeof fn.name === "string" ? fn.name : "tool", arguments: "", started: false };
      this.tools.set(toolIndex, state);
    } else {
      if (typeof delta.id === "string") state.callId = delta.id;
      if (typeof fn.name === "string") state.name = fn.name;
    }
    if (!state.started) {
      state.started = true;
      output.push(this.event("response.output_item.added", { output_index: state.outputIndex, item: { id: state.itemId, type: "function_call", status: "in_progress", call_id: state.callId, name: state.name, arguments: "" } }));
    }
    if (typeof fn.arguments === "string" && fn.arguments) {
      if (state.arguments.length + fn.arguments.length <= MAX_COMPLETED_TEXT) state.arguments += fn.arguments;
      output.push(this.event("response.function_call_arguments.delta", { item_id: state.itemId, output_index: state.outputIndex, delta: fn.arguments }));
    }
    return output;
  }

  private finish(): string[] {
    if (this.finalized) return [];
    this.finalized = true;
    const output = this.start();
    const completedItems: JsonObject[] = [];
    if (this.textStarted) {
      const completedText = this.textTruncated ? "" : this.text;
      output.push(this.event("response.output_text.done", { item_id: this.messageItemId, output_index: this.messageOutputIndex, content_index: 0, text: completedText }));
      output.push(this.event("response.content_part.done", { item_id: this.messageItemId, output_index: this.messageOutputIndex, content_index: 0, part: { type: "output_text", text: completedText, annotations: [] } }));
      const item = { id: this.messageItemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: completedText, annotations: [] }] };
      output.push(this.event("response.output_item.done", { output_index: this.messageOutputIndex, item }));
      completedItems.push(item);
    }
    for (const state of [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      output.push(this.event("response.function_call_arguments.done", { item_id: state.itemId, output_index: state.outputIndex, arguments: state.arguments }));
      const item = { id: state.itemId, type: "function_call", status: "completed", call_id: state.callId, name: state.name, arguments: state.arguments };
      output.push(this.event("response.output_item.done", { output_index: state.outputIndex, item }));
      completedItems.push(item);
    }
    const status = this.finishReason === "content_filter" ? "failed" : "completed";
    output.push(this.event("response.completed", { response: this.response(status, completedItems) }));
    return output;
  }

  frame(frame: SseFrame): string[] {
    if (frame.data === "[DONE]") return this.finish();
    let payload: JsonObject;
    try { payload = JSON.parse(frame.data) as JsonObject; }
    catch { return []; }
    if (payload.error) {
      this.finalized = true;
      return [this.event("error", { error: payload.error })];
    }
    const usage = openAIUsage(payload);
    if (usage.input || usage.output || usage.total) this.usage = usage;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const output: string[] = [];
    for (const rawChoice of choices) {
      const choice = object(rawChoice);
      if (!choice) continue;
      const delta = object(choice.delta) || {};
      if (typeof delta.content === "string" && delta.content) output.push(...this.appendText(delta.content, payload));
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawTool of toolCalls) {
        const tool = object(rawTool);
        if (tool) output.push(...this.appendTool(tool, number(tool.index), payload));
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) this.finishReason = choice.finish_reason;
    }
    if (!this.created && choices.length) output.push(...this.start(payload));
    return output;
  }

  end(): string[] {
    return this.finish();
  }
}

class WorkersAIToChatMapper implements SseMapper {
  private readonly id = `chat_${crypto.randomUUID()}`;
  private done = false;
  private finished = false;

  constructor(private readonly model: string) {}

  frame(frame: SseFrame): string[] {
    if (frame.data === "[DONE]") return this.end();
    let payload: JsonObject;
    try { payload = JSON.parse(frame.data) as JsonObject; }
    catch { return []; }
    if (payload.error) {
      this.done = true;
      return [`data: ${JSON.stringify({ error: payload.error })}\n\n`];
    }
    if (Array.isArray(payload.choices)) {
      const choice = object(payload.choices[0]) ?? {};
      const delta = object(choice.delta) ?? {};
      const content = typeof delta.content === "string" ? delta.content : "";
      const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
      const usage = object(payload.usage);
      const chunk: JsonObject = {
        id: this.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{
          index: 0,
          delta: content ? { role: "assistant", content } : {},
          finish_reason: finish,
        }],
      };
      if (usage) {
        const promptTokens = number(usage.prompt_tokens ?? usage.input_tokens);
        const completionTokens = number(usage.completion_tokens ?? usage.output_tokens);
        chunk.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: number(usage.total_tokens) || promptTokens + completionTokens };
      }
      if (finish) this.finished = true;
      return [`data: ${JSON.stringify(chunk)}\n\n`];
    }
    const output: string[] = [];
    if (typeof payload.response === "string" && payload.response) {
      output.push(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", model: this.model, choices: [{ index: 0, delta: { content: payload.response }, finish_reason: null }] })}\n\n`);
    }
    const usage = object(payload.usage);
    if (usage) {
      const promptTokens = number(usage.prompt_tokens ?? usage.input_tokens);
      const completionTokens = number(usage.completion_tokens ?? usage.output_tokens);
      output.push(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", model: this.model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: number(usage.total_tokens) || promptTokens + completionTokens } })}\n\n`);
    }
    return output;
  }

  end(): string[] {
    if (this.done) return [];
    this.done = true;
    const frames = this.finished
      ? []
      : [`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", model: this.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`];
    frames.push("data: [DONE]\n\n");
    return frames;
  }
}

export function chatStreamToMessages(upstream: Response, model: string): Response {
  return transformedSse(upstream, new ChatToMessagesMapper(model));
}

export function chatStreamToResponses(upstream: Response, model: string): Response {
  return transformedSse(upstream, new ChatToResponsesMapper(model));
}

export function workersAIStreamToChat(upstream: Response, model: string): Response {
  return transformedSse(upstream, new WorkersAIToChatMapper(model));
}
