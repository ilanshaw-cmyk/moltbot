import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  setSseHeaders,
  writeDone,
} from "./http-common.js";
import { getBearerToken, resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
};

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractMediaLinesFromPayloads(
  payloads: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }> | undefined,
): string {
  if (!Array.isArray(payloads) || payloads.length === 0) return "";
  const media: string[] = [];
  for (const p of payloads) {
    const urls = p.mediaUrls ?? (p.mediaUrl ? [p.mediaUrl] : []);
    for (const url of urls) {
      if (typeof url === "string" && url.trim()) {
        media.push(url.trim());
      }
    }
  }
  if (media.length === 0) return "";
  return media.map((u) => `MEDIA:${u}`).join("\n\n");
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        // NOTE: We intentionally ignore image blocks here.
        if (type === "text" && typeof text === "string") return text;
        if (type === "input_text" && typeof text === "string") return text;
        if (typeof inputText === "string") return inputText;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractImageDataUrls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const type = (part as { type?: unknown }).type;
    if (type !== "image_url") continue;

    const raw = (part as any).image_url;
    if (typeof raw === "string") {
      const s = raw.trim();
      if (s.startsWith("data:image/")) urls.push(s);
      continue;
    }
    if (raw && typeof raw === "object") {
      const url = typeof raw.url === "string" ? raw.url.trim() : "";
      if (url.startsWith("data:image/")) urls.push(url);
      continue;
    }
  }
  return urls;
}

function buildAgentPrompt(messagesUnknown: unknown): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: Array<{ role: "user" | "assistant" | "tool"; entry: HistoryEntry }> =
    [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const content = extractTextContent(msg.content).trim();
    if (!role || !content) continue;
    if (role === "system" || role === "developer") {
      systemParts.push(content);
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: content },
    });
  }

  let message = "";
  if (conversationEntries.length > 0) {
    let currentIndex = -1;
    for (let i = conversationEntries.length - 1; i >= 0; i -= 1) {
      const entryRole = conversationEntries[i]?.role;
      if (entryRole === "user" || entryRole === "tool") {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex < 0) currentIndex = conversationEntries.length - 1;
    const currentEntry = conversationEntries[currentIndex]?.entry;
    if (currentEntry) {
      const historyEntries = conversationEntries.slice(0, currentIndex).map((entry) => entry.entry);
      if (historyEntries.length === 0) {
        message = currentEntry.body;
      } else {
        const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${entry.body}`;
        message = buildHistoryContextFromEntries({
          entries: [...historyEntries, currentEntry],
          currentMessage: formatEntry(currentEntry),
          formatEntry,
        });
      }
    }
  }

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenAiSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openai" });
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") return {};
  return val as OpenAiChatCompletionRequest;
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/v1/chat/completions") return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  // A2PM can attach multiple images as base64 data URLs (OpenAI-compatible `image_url` blocks),
  // which can easily exceed 1MB. Use a larger default body limit for this endpoint.
  // (Still protected by gateway auth.)
  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? 30 * 1024 * 1024);
  if (body === undefined) return true;

  const payload = coerceRequest(body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenAiSessionKey({ req, agentId, user });
  const prompt = buildAgentPrompt(payload.messages);
  const lastMessageContent = (payload as any).messages?.[
    Array.isArray((payload as any).messages) ? (payload as any).messages.length - 1 : 0
  ]?.content;
  const imageDataUrls = extractImageDataUrls(lastMessageContent);
  const imageContent =
    imageDataUrls.length > 0
      ? imageDataUrls
          .map((imageDataUrl) => {
            const mimeType = imageDataUrl.match(/^data:([^;]+);base64,/i)?.[1] ?? "image/png";
            const data = imageDataUrl.replace(/^data:[^;]+;base64,/i, "");
            if (!data) return null;
            return { type: "image" as const, data, mimeType };
          })
          .filter(Boolean)
      : undefined;
  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();

  if (!stream) {
    try {
      const result = await agentCommand(
        {
          message: prompt.message,
          extraSystemPrompt: prompt.extraSystemPrompt,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
          images: imageContent as any,
        },
        defaultRuntime,
        deps,
      );

      const payloads = (
        result as {
          payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
        } | null
      )?.payloads;
      // Build content from payloads, re-appending MEDIA lines for API consumers
      // (OpenClaw strips MEDIA: tokens during normalization, but API clients like A2PM need them)
      let content = "No response from OpenClaw.";
      if (Array.isArray(payloads) && payloads.length > 0) {
        const parts: string[] = [];
        for (const p of payloads) {
          if (typeof p.text === "string" && p.text) parts.push(p.text);
          const mediaLines = extractMediaLinesFromPayloads([p]);
          if (mediaLines) parts.push(mediaLines);
        }
        content = parts.filter(Boolean).join("\n\n");
      }

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: String(err), type: "api_error" },
      });
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) return;
    if (closed) return;

    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      const text = evt.data?.text;
      const content = typeof delta === "string" ? delta : typeof text === "string" ? text : "";
      if (!content) return;

      if (!wroteRole) {
        wroteRole = true;
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant" } }],
        });
      }

      sawAssistantDelta = true;
      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      // IMPORTANT: don't close the SSE stream on lifecycle "end".
      // `agentCommand()` resolves *after* lifecycle end is emitted, and we still need to append any
      // MEDIA lines derived from the final payloads before sending [DONE].
      if (phase === "error") {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommand(
        {
          message: prompt.message,
          extraSystemPrompt: prompt.extraSystemPrompt,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
          images: imageContent as any,
        },
        defaultRuntime,
        deps,
      );

      if (closed) return;

      const payloads = (
        result as {
          payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
        } | null
      )?.payloads;
      const mediaLines = extractMediaLinesFromPayloads(payloads);

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeSse(res, {
            id: runId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: "assistant" } }],
          });
        }

        const payloads = (
          result as {
            payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
          } | null
        )?.payloads;
        // Build content from payloads, re-appending MEDIA lines for API consumers
        let content = "No response from OpenClaw.";
        if (Array.isArray(payloads) && payloads.length > 0) {
          const parts: string[] = [];
          for (const p of payloads) {
            if (typeof p.text === "string" && p.text) parts.push(p.text);
            const perPayloadMedia = extractMediaLinesFromPayloads([p]);
            if (perPayloadMedia) parts.push(perPayloadMedia);
          }
          content = parts.filter(Boolean).join("\n\n");
        }

        sawAssistantDelta = true;
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content },
              finish_reason: null,
            },
          ],
        });
      }

      // Even when the assistant streamed deltas, we still need to append MEDIA lines for API consumers
      // (A2PM uses these to copy the image into durable storage and embed it in the conversation).
      if (!closed && mediaLines) {
        if (!wroteRole) {
          wroteRole = true;
          writeSse(res, {
            id: runId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: "assistant" } }],
          });
        }
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content: `\n\n${mediaLines}` },
              finish_reason: null,
            },
          ],
        });
      }
    } catch (err) {
      if (closed) return;
      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: `Error: ${String(err)}` },
            finish_reason: "stop",
          },
        ],
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
