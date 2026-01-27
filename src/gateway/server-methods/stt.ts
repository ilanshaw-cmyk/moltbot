import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Resolves the OpenAI API key for STT from skill config or environment.
 */
function resolveOpenAIKey(cfg: ReturnType<typeof loadConfig>): string | null {
  // Check skill-specific config first
  const skillKey = cfg.skills?.entries?.["openai-whisper-api"]?.apiKey;
  if (typeof skillKey === "string" && skillKey.trim()) {
    return skillKey.trim();
  }
  // Fall back to environment variable
  const envKey = process.env.OPENAI_API_KEY;
  if (typeof envKey === "string" && envKey.trim()) {
    return envKey.trim();
  }
  return null;
}

export const sttHandlers: GatewayRequestHandlers = {
  "stt.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const hasKey = Boolean(resolveOpenAIKey(cfg));
      respond(true, {
        available: hasKey,
        provider: hasKey ? "openai" : null,
        model: "whisper-1",
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  "stt.transcribe": async ({ params, respond }) => {
    // Expect base64-encoded audio data
    const audioData = typeof params.audio === "string" ? params.audio : "";
    const mimeType = typeof params.mimeType === "string" ? params.mimeType : "audio/webm";
    const language = typeof params.language === "string" ? params.language.trim() : undefined;
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : undefined;

    if (!audioData) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "stt.transcribe requires audio (base64)"),
      );
      return;
    }

    try {
      const cfg = loadConfig();
      const apiKey = resolveOpenAIKey(cfg);

      if (!apiKey) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "OpenAI API key not configured. Set it in skills.entries.openai-whisper-api.apiKey or OPENAI_API_KEY env var.",
          ),
        );
        return;
      }

      // Convert base64 to buffer
      const audioBuffer = Buffer.from(audioData, "base64");

      // Determine file extension from MIME type
      const extMap: Record<string, string> = {
        "audio/webm": "webm",
        "audio/mp4": "m4a",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
        "audio/ogg": "ogg",
        "audio/flac": "flac",
      };
      const ext = extMap[mimeType] ?? "webm";

      // Build form data for OpenAI API using native FormData
      const form = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      form.append("file", blob, `audio.${ext}`);
      form.append("model", "whisper-1");
      form.append("response_format", "text");
      if (language) {
        form.append("language", language);
      }
      if (prompt) {
        form.append("prompt", prompt);
      }

      // Call OpenAI Whisper API
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      });

      if (!response.ok) {
        const errorText = await response.text();
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `OpenAI API error (${response.status}): ${errorText}`),
        );
        return;
      }

      const transcript = await response.text();

      respond(true, {
        text: transcript.trim(),
        model: "whisper-1",
        language: language ?? "auto",
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
