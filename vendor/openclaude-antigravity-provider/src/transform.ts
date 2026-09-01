/**
 * transform.ts
 * Translates OpenAI Chat Completions requests → Gemini GenerateContent format.
 * Translates Gemini SSE chunks → OpenAI SSE chunks.
 */

import {
  resolveAntigravityModel,
  generateSyntheticProjectId,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
} from "./constants.ts";

// ── OpenAI input types ────────────────────────────────────────────────────────

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentPart[];
}

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

// ── Gemini internal types ─────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiRequest {
  project: string;
  model: string;
  requestType: "agent";
  userAgent: "antigravity";
  requestId: string;
  request: {
    contents: GeminiContent[];
    sessionId: string;
    systemInstruction?: { role: "user"; parts: GeminiPart[] };
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
      topP?: number;
    };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function contentToText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

function toGeminiRole(role: OpenAIMessage["role"]): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

// ── Main translation: OpenAI → Gemini ────────────────────────────────────────

export interface TranslatedRequest {
  body: GeminiRequest;
  /** Ordered list of endpoints to try (daily → autopush → prod). */
  endpoints: readonly string[];
}

export function translateToGemini(
  req: OpenAIChatRequest,
  sessionId: string,
): TranslatedRequest {
  // Daily sandbox serves bare names with tier/thinking suffixes (see
  // ANTIGRAVITY_MODEL_MAP notes) — NOT the -preview generativelanguage names.
  const geminiModel = resolveAntigravityModel(req.model);

  // Pull out system message
  let systemInstruction: { role: "user"; parts: GeminiPart[] } | undefined;
  const turns = req.messages.filter((m) => {
    if (m.role === "system") {
      systemInstruction = { role: "user", parts: [{ text: contentToText(m.content) }] };
      return false;
    }
    return true;
  });

  // Build contents, merging consecutive same-role turns (Gemini requires alternating)
  const contents: GeminiContent[] = [];
  for (const msg of turns) {
    const role = toGeminiRole(msg.role);
    const text = contentToText(msg.content);
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text });
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }

  // Gemini requires the first turn to be "user"
  if (contents.length === 0 || contents[0]?.role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "" }] });
  }

  // Antigravity Manager-style wrapped body. The synthetic project +
  // requestType "agent" route the request into the Antigravity agent quota
  // pool on the daily sandbox (unlimited), instead of the per-account
  // free tier that the prod endpoint enforces.
  const body: GeminiRequest = {
    project: generateSyntheticProjectId(),
    model: geminiModel,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      contents,
      sessionId,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.max_tokens !== undefined ? { maxOutputTokens: req.max_tokens } : {}),
        ...(req.top_p !== undefined ? { topP: req.top_p } : {}),
      },
    },
  };

  const endpoints = ANTIGRAVITY_ENDPOINT_FALLBACKS.map(
    (base) => `${base}/v1internal:streamGenerateContent?alt=sse`,
  );
  return { body, endpoints };
}

// ── Gemini SSE chunk → OpenAI SSE chunk ──────────────────────────────────────

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface GeminiChunk {
  response?: { candidates?: GeminiCandidate[] };
  candidates?: GeminiCandidate[];
}

export function translateGeminiChunkToOpenAI(
  rawLine: string,
  model: string,
  chunkId: string,
): string | null {
  if (!rawLine.startsWith("data:")) return null;
  const payload = rawLine.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;

  let parsed: GeminiChunk;
  try {
    parsed = JSON.parse(payload) as GeminiChunk;
  } catch {
    return null;
  }

  // Daily sandbox SSE chunks nest the payload under "response";
  // some endpoints emit it flat — support both.
  const candidates = parsed.response?.candidates ?? parsed.candidates;
  if (!candidates || candidates.length === 0) return null;

  const candidate = candidates[0]!;
  const text =
    candidate.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const finishReason =
    candidate.finishReason === "STOP"
      ? "stop"
      : candidate.finishReason === "MAX_TOKENS"
        ? "length"
        : null;

  const chunk = {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: text ? { role: "assistant", content: text } : {},
        finish_reason: finishReason,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── Full non-streaming response translation ───────────────────────────────────

export function translateGeminiResponseToOpenAI(
  geminiBody: unknown,
  model: string,
  chunkId: string,
): Record<string, unknown> {
  // Unwrap the "response" envelope when present (daily sandbox shape)
  const unwrapped = (
    (geminiBody as { response?: unknown }).response ?? geminiBody
  ) as { candidates?: GeminiCandidate[] };
  const candidates = unwrapped.candidates ?? [];
  const text =
    candidates[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const finishReason =
    candidates[0]?.finishReason === "STOP" ? "stop" : "length";

  return {
    id: chunkId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
