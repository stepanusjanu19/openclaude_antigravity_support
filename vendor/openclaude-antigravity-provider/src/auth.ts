/**
 * auth.ts
 * Google OAuth 2.0 PKCE flow using Bun native crypto and fetch.
 * No external dependencies — purely Bun built-ins.
 */

import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_PORT,
  GOOGLE_OAUTH_SCOPES,
} from "./constants.ts";

const REDIRECT_URI = `http://localhost:${GOOGLE_OAUTH_REDIRECT_PORT}/oauth-callback`;

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface AuthorizationUrlResult {
  url: string;
  verifier: string;
  state: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  email?: string;
}

export interface AccessTokenResult {
  access: string;
  expires: number;
}

// ── Build the Google authorization URL ───────────────────────────────────────

export async function buildAuthorizationUrl(): Promise<AuthorizationUrlResult> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, verifier, state };
}

// ── Exchange authorization code for tokens ────────────────────────────────────

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token?: string;
  };

  // Decode email from id_token JWT payload
  let email: string | undefined;
  if (data.id_token) {
    try {
      const payloadB64 = data.id_token.split(".")[1]!;
      const payload = JSON.parse(atob(payloadB64)) as { email?: string };
      email = payload.email;
    } catch {
      // ignore decode errors
    }
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    email,
  };
}

// ── Refresh an existing access token ──────────────────────────────────────────

export async function refreshAccessToken(
  refreshToken: string,
): Promise<AccessTokenResult> {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    // Subtract 60s buffer so we refresh before actual expiry
    expires: Date.now() + data.expires_in * 1000 - 60_000,
  };
}

export function accessTokenExpired(expires: number): boolean {
  return Date.now() >= expires;
}

// ── Local OAuth callback server (Bun.serve) ───────────────────────────────────

export function waitForOAuthCallback(
  expectedState: string,
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof Bun.serve> | null = null;

    const timeout = setTimeout(() => {
      server?.stop(true);
      reject(new Error("OAuth callback timed out after 5 minutes."));
    }, 5 * 60 * 1000);

    server = Bun.serve({
      port: GOOGLE_OAUTH_REDIRECT_PORT,
      hostname: "localhost",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/oauth-callback") {
          return new Response("Not found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || state !== expectedState) {
          return new Response("Invalid OAuth callback.", { status: 400 });
        }

        clearTimeout(timeout);
        server?.stop(true);

        resolve({ code, state });

        return new Response(
          `<html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <h2>Authentication successful!</h2>
            <p>You can close this tab and return to OpenClaude.</p>
          </body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
  });
}
