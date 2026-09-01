/**
 * server.ts
 * OpenAI-compatible local proxy using Bun.serve().
 * Endpoint: http://localhost:51122/v1/chat/completions
 *
 * Run:  bun run src/server.ts
 */

import {
  PROXY_PORT,
  AVAILABLE_MODELS,
  getAntigravityUserAgent,
  ACCOUNTS_FILE,
  isClaudeModel,
} from "./constants.ts";
import {
  getAvailableAccount,
  getValidAccessToken,
  markAccountRateLimited,
  markAccountUsed,
  getAccountCount,
} from "./accounts.ts";
import {
  translateToGemini,
  translateGeminiChunkToOpenAI,
  translateGeminiResponseToOpenAI,
  type OpenAIChatRequest,
} from "./transform.ts";
import { getGeminiCliProfile } from "./config.ts";
import { handleGeminiCliFallback } from "./gemini-fallback.ts";

const MAX_RETRIES = 3;

// Stable session id for the Antigravity agent request wrapper (reused across
// requests for the lifetime of the proxy process, mirroring the IDE behavior).
const PROXY_SESSION_ID = crypto.randomUUID();

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function errorResponse(message: string, type: string, status: number): Response {
  return jsonResponse({ error: { message, type } }, status);
}

function parseRetryAfterMs(
  headers: Headers,
  defaultMs = 60_000,
): number {
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const v = parseInt(ms, 10);
    if (!isNaN(v) && v > 0) return v;
  }
  const sec = headers.get("retry-after");
  if (sec) {
    const v = parseInt(sec, 10);
    if (!isNaN(v) && v > 0) return v * 1000;
  }
  return defaultMs;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── /v1/models ────────────────────────────────────────────────────────────────

function handleModels(): Response {
  const now = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: "list",
    data: AVAILABLE_MODELS.map((id) => ({
      id,
      object: "model",
      created: now,
      owned_by: "google-antigravity",
    })),
  });
}

// ── /health ───────────────────────────────────────────────────────────────────

async function handleHealth(): Promise<Response> {
  const geminiProfile = await getGeminiCliProfile();
  return jsonResponse({
    status: "ok",
    accounts: await getAccountCount(),
    geminiCliFallback: geminiProfile !== null,
  });
}

// ── /v1/chat/completions ─────────────────────────────────────────────────────

async function handleChatCompletions(req: Request): Promise<Response> {
  // Parse request body
  let body: OpenAIChatRequest;
  try {
    body = (await req.json()) as OpenAIChatRequest;
  } catch {
    return errorResponse("Invalid JSON body", "invalid_request_error", 400);
  }

  const count = await getAccountCount();
  if (count === 0) {
    return errorResponse(
      "No Antigravity accounts configured. Run: bun run src/auth-cli.ts",
      "authentication_error",
      401,
    );
  }

  const isStream = body.stream !== false;
  const chunkId = `chatcmpl-${randomId()}`;

  const { body: geminiBody, endpoints } = translateToGemini(body, PROXY_SESSION_ID);

  let lastError = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Select account
    let accountInfo: Awaited<ReturnType<typeof getAvailableAccount>>;
    try {
      accountInfo = await getAvailableAccount();
    } catch (err: unknown) {
      // All Antigravity accounts are rate-limited.
      // For Gemini models: transparently fall over to the Gemini-CLI provider.
      // For Claude models: return 429 so OpenClaude can handle it normally.
      if (!isClaudeModel(body.model)) {
        const geminiProfile = await getGeminiCliProfile();
        if (geminiProfile) {
          return handleGeminiCliFallback(body, geminiProfile);
        }
      }
      return errorResponse(
        String(err instanceof Error ? err.message : err),
        "rate_limit_error",
        429,
      );
    }

    if (!accountInfo) {
      return errorResponse("No available accounts.", "authentication_error", 401);
    }

    const { account, index } = accountInfo;

    // Get fresh access token
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(account);
    } catch (err: unknown) {
      lastError = String(err instanceof Error ? err.message : err);
      continue;
    }

    // Antigravity Manager-style headers: ONLY the User-Agent is sent on
    // content requests — no X-Goog-Api-Client, no Client-Metadata, and no
    // x-goog-user-project (the project rides in the request body). Anything
    // more routes the request into the per-account free-tier quota.
    const upstreamHeaders: Record<string, string> = {
      "User-Agent": getAntigravityUserAgent(),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(isStream ? { Accept: "text/event-stream" } : {}),
    };

    // Try each endpoint in order (daily → autopush → prod).
    // A network-level failure advances to the next endpoint; a 429 rotates accounts.
    let upstream: Response | null = null;
    let endpointError = "";
    for (const endpoint of endpoints) {
      try {
        upstream = await fetch(endpoint, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(geminiBody),
        });
        // If the endpoint itself is down (5xx gateway), try the next one
        if (upstream.status >= 502 && upstream.status <= 504) {
          endpointError = `Endpoint ${endpoint} returned ${upstream.status}`;
          upstream = null;
          continue;
        }
        break; // got a real response (success or app-level error)
      } catch (err: unknown) {
        endpointError = `Network error on ${endpoint}: ${String(err instanceof Error ? err.message : err)}`;
        upstream = null;
      }
    }

    if (!upstream) {
      lastError = endpointError;
      continue;
    }

    // Handle rate limit — rotate to next account
    if (upstream.status === 429) {
      const retryAfterMs = parseRetryAfterMs(upstream.headers);
      await markAccountRateLimited(index, retryAfterMs);
      lastError = `Account ${account.email ?? index} rate-limited for ${Math.ceil(retryAfterMs / 1000)}s`;
      continue;
    }

    // Handle other upstream errors
    if (!upstream.ok) {
      const errText = await upstream.text();
      await markAccountUsed(index);
      return errorResponse(
        `Upstream error (${upstream.status}): ${errText}`,
        "upstream_error",
        upstream.status,
      );
    }

    await markAccountUsed(index);

    // ── Streaming ──────────────────────────────────────────────────────────
    if (isStream) {
      const upstreamBody = upstream.body;
      if (!upstreamBody) {
        return errorResponse("Empty upstream body", "upstream_error", 502);
      }

      const stream = new ReadableStream({
        async start(controller) {
          const reader = upstreamBody.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const translated = translateGeminiChunkToOpenAI(
                  trimmed,
                  body.model,
                  chunkId,
                );
                if (translated) {
                  controller.enqueue(new TextEncoder().encode(translated));
                }
              }
            }
          } catch {
            // Stream ended or client disconnected
          }

          controller.enqueue(
            new TextEncoder().encode("data: [DONE]\n\n"),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Non-streaming ──────────────────────────────────────────────────────
    let geminiResponseBody: unknown;
    try {
      geminiResponseBody = await upstream.json();
    } catch {
      return errorResponse(
        "Upstream returned invalid JSON",
        "upstream_error",
        502,
      );
    }

    return jsonResponse(
      translateGeminiResponseToOpenAI(geminiResponseBody, body.model, chunkId),
    );
  }

  // All retries exhausted — attempt Gemini-CLI fallback for Gemini models.
  if (!isClaudeModel(body.model)) {
    const geminiProfile = await getGeminiCliProfile();
    if (geminiProfile) {
      return handleGeminiCliFallback(body, geminiProfile);
    }
  }

  return errorResponse(
    `All retries failed. Last error: ${lastError}`,
    "service_unavailable",
    503,
  );
}

// ── Bun.serve router ──────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PROXY_PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/health" || url.pathname === "/v1/health") {
      return handleHealth();
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return handleModels();
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return handleChatCompletions(req);
    }

    return errorResponse("Not found", "not_found", 404);
  },

  error(err) {
    console.error("[antigravity-provider] Server error:", err.message);
    return errorResponse("Internal server error", "internal_error", 500);
  },
});

console.log(
  `[antigravity-provider] Proxy running → http://${server.hostname}:${server.port}/v1`,
);
console.log(`[antigravity-provider] Accounts file  → ${ACCOUNTS_FILE}`);
console.log(
  `[antigravity-provider] Health check  → http://localhost:${server.port}/health`,
);
