/**
 * constants.ts
 * Antigravity API endpoints, model map, and storage paths.
 * All paths anchored to ~/.openclaude/ (OpenClaude's config dir).
 */

export const PROXY_PORT = 51122;
export const GOOGLE_OAUTH_REDIRECT_PORT = 51121;

// Antigravity endpoint fallback order (daily → autopush → prod)
export const ANTIGRAVITY_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH =
  "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD =
  "https://cloudcode-pa.googleapis.com";

// Primary endpoint used for requests — daily sandbox mirrors the OpenCode plugin
// and has no per-account Free Tier quota limits (unlike the prod endpoint).
export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY;

// Ordered fallback chain: try daily first, then autopush, then prod.
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD,
] as const;

// NOTE: The opencode-antigravity-auth plugin defaults to project
// "rising-fact-p41fc", but that shared project is only usable by accounts
// provisioned through its loadCodeAssist discovery flow. Our accounts have no
// project IDs, and forcing this one is rejected with USER_PROJECT_DENIED.
// The correct behavior is to OMIT x-goog-user-project when the account has
// no project of its own — kept here for documentation only.
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

// Real Antigravity OAuth app credentials (from opencode-antigravity-auth)
export const GOOGLE_OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

export const GOOGLE_OAUTH_CLIENT_SECRET = "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";

export const GOOGLE_AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// OpenClaude config directory (Windows: C:\Users\<user>\.openclaude)
export const OPENCLAUDE_CONFIG_DIR =
  `${process.env.USERPROFILE ?? process.env.HOME ?? "~"}/.openclaude`;

export const ACCOUNTS_FILE = `${OPENCLAUDE_CONFIG_DIR}/antigravity-accounts.json`;

export const PROXY_PID_FILE = `${OPENCLAUDE_CONFIG_DIR}/antigravity-proxy.pid`;

// Exact scopes required by the Antigravity OAuth app
export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

// Maps OpenAI-style model names to Gemini API model names
// (used by the generativelanguage Gemini-CLI fallback path)
export const MODEL_MAP: Record<string, string> = {
  "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
  "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6",
  "antigravity-gemini-3-pro": "gemini-3-pro-preview",
  "antigravity-gemini-3.1-pro": "gemini-3.1-pro-preview",
  "antigravity-gemini-3-flash": "gemini-3-flash-preview",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-3-flash-preview": "gemini-3-flash-preview",
  "gemini-3-pro-preview": "gemini-3-pro-preview",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
};

// Maps exposed model IDs to the names served by the Antigravity daily sandbox.
// Empirically verified (200 OK) against daily-cloudcode-pa.sandbox.googleapis.com:
//   - Pro models REQUIRE a thinking-tier suffix (-low / -high)
//   - Flash models use the BARE name (tier suffix -> 404)
//   - Claude Sonnet uses the bare name; Claude Opus REQUIRES -thinking
export const ANTIGRAVITY_MODEL_MAP: Record<string, string> = {
  "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
  "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
  "antigravity-gemini-3-pro": "gemini-3-pro-low",
  "antigravity-gemini-3.1-pro": "gemini-3.1-pro-low",
  "antigravity-gemini-3-flash": "gemini-3-flash",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3-pro-preview": "gemini-3-pro-low",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-low",
};

export const AVAILABLE_MODELS = Object.keys(MODEL_MAP);

export function isClaudeModel(model: string): boolean {
  return model.includes("claude");
}

export function resolveGeminiModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

export function resolveAntigravityModel(model: string): string {
  return ANTIGRAVITY_MODEL_MAP[model] ?? model;
}

// Antigravity-style User-Agent — the Antigravity Manager sends ONLY this
// header (no X-Goog-Api-Client / Client-Metadata) on content requests.
export function getAntigravityUserAgent(): string {
  const platform = process.platform === "win32" ? "windows/amd64" : "darwin/arm64";
  return `antigravity/1.18.3 ${platform}`;
}

const SYNTHETIC_PROJECT_ADJECTIVES = ["useful", "bright", "swift", "calm", "bold"];
const SYNTHETIC_PROJECT_NOUNS = ["fuze", "wave", "spark", "flow", "core"];

// Synthetic project id (same scheme as opencode-antigravity-auth). The daily
// sandbox accepts arbitrary ids here — the project routes the request into
// the Antigravity agent quota pool instead of the per-account free tier.
export function generateSyntheticProjectId(): string {
  const adj = SYNTHETIC_PROJECT_ADJECTIVES[Math.floor(Math.random() * SYNTHETIC_PROJECT_ADJECTIVES.length)]!;
  const noun = SYNTHETIC_PROJECT_NOUNS[Math.floor(Math.random() * SYNTHETIC_PROJECT_NOUNS.length)]!;
  const randomPart = crypto.randomUUID().slice(0, 5).toLowerCase();
  return `${adj}-${noun}-${randomPart}`;
}

export function getAntigravityHeaders(): Record<string, string> {
  const platform = process.platform === "win32" ? "WINDOWS" : "MACOS";
  return {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${platform}","pluginType":"GEMINI"}`,
  };
}
