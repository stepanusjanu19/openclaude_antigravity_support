/**
 * gemini-fallback.ts
 *
 * When ALL Antigravity OAuth accounts are rate-limited on a Gemini model
 * request, this module forwards the request directly to the official
 * Google Gemini OpenAI-compatible endpoint using the Gemini-CLI API key
 * stored in ~/.openclaude.json.
 *
 * Claude model requests are NOT routed here — they always return the 429
 * back to OpenClaude so the normal per-provider retry logic applies.
 *
 * The Gemini endpoint at generativelanguage.googleapis.com/v1beta/openai
 * is fully OpenAI-compatible, so no payload translation is needed.
 * We only swap the model name to the native Gemini model ID.
 */

import type { OpenAIChatRequest } from "./transform.ts";
import type { GeminiCliProfile } from "./config.ts";
import { MODEL_MAP } from "./constants.ts";

// ---------------------------------------------------------------------------
// Resolve the native Gemini model name for the fallback request.
// MODEL_MAP already has the mapping (e.g. "antigravity-gemini-3.1-pro" ->
// "gemini-3.1-pro-preview").  Fall back to the model name as-is if it
// doesn't appear in the map (e.g. the user already requested a raw model id).
// ---------------------------------------------------------------------------
function resolveNativeGeminiModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

// ---------------------------------------------------------------------------
// Build the fallback OpenAI-compatible payload.
// We clone the original body and replace the model with the native name.
// ---------------------------------------------------------------------------
function buildFallbackPayload(body: OpenAIChatRequest): OpenAIChatRequest {
  return {
    ...body,
    model: resolveNativeGeminiModel(body.model),
  };
}

// ---------------------------------------------------------------------------
// Forward a streaming request to the Gemini-CLI endpoint and pipe the
// SSE stream back.  Returns a Response whose body is the upstream SSE stream.
// ---------------------------------------------------------------------------
async function streamFallback(
  profile: GeminiCliProfile,
  payload: OpenAIChatRequest,
): Promise<Response> {
  const upstream = await fetch(`${profile.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "(unreadable)");
    return new Response(
      JSON.stringify({
        error: {
          message: `Gemini-CLI fallback upstream error (${upstream.status}): ${errText}`,
          type: "upstream_error",
        },
      }),
      {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Pipe the upstream SSE stream directly — the Gemini OpenAI-compatible
  // endpoint emits standard "data: {...}\n\n" chunks identical to what
  // OpenClaude expects, so no translation is required.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Antigravity-Fallback": "gemini-cli",
    },
  });
}

// ---------------------------------------------------------------------------
// Forward a non-streaming request to the Gemini-CLI endpoint.
// ---------------------------------------------------------------------------
async function jsonFallback(
  profile: GeminiCliProfile,
  payload: OpenAIChatRequest,
): Promise<Response> {
  const upstream = await fetch(`${profile.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await upstream.text();

  if (!upstream.ok) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Gemini-CLI fallback upstream error (${upstream.status}): ${body}`,
          type: "upstream_error",
        },
      }),
      {
        status: upstream.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Pass the JSON response through directly with the fallback header so
  // logs / health checks can distinguish the path taken.
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Antigravity-Fallback": "gemini-cli",
    },
  });
}

// ---------------------------------------------------------------------------
// Public entry point called from server.ts when all Antigravity accounts
// are exhausted on a Gemini model request.
// ---------------------------------------------------------------------------
export async function handleGeminiCliFallback(
  body: OpenAIChatRequest,
  profile: GeminiCliProfile,
): Promise<Response> {
  const payload = buildFallbackPayload(body);
  const isStream = body.stream !== false;

  console.log(
    `[antigravity-provider] Gemini-CLI fallback: ${body.model} -> ${payload.model} (stream=${isStream})`,
  );

  if (isStream) {
    return streamFallback(profile, payload);
  }
  return jsonFallback(profile, payload);
}
