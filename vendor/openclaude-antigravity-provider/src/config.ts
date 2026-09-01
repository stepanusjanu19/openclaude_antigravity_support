/**
 * config.ts
 * Reads ~/.openclaude.json and extracts the Gemini-CLI provider profile
 * so the proxy can use its API key as a fallback when all Antigravity
 * OAuth accounts are rate-limited on a Gemini model request.
 */

import { OPENCLAUDE_CONFIG_DIR } from "./constants.ts";
import { join } from "node:path";

export interface GeminiCliProfile {
  /** The base URL without trailing slash, e.g.
   *  "https://generativelanguage.googleapis.com/v1beta/openai" */
  baseUrl: string;
  /** Gemini API key */
  apiKey: string;
}

interface ProviderProfile {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model?: string;
  apiKey?: string;
}

interface OpenClaudeConfig {
  providerProfiles?: ProviderProfile[];
}

const CONFIG_FILE = join(OPENCLAUDE_CONFIG_DIR, "..", ".openclaude.json");

// In-memory cache so we don't stat the file on every request.
let cached: GeminiCliProfile | null | undefined = undefined; // undefined = not yet loaded

export async function getGeminiCliProfile(): Promise<GeminiCliProfile | null> {
  if (cached !== undefined) return cached;

  try {
    const file = Bun.file(CONFIG_FILE);
    if (!(await file.exists())) {
      cached = null;
      return null;
    }
    const config = (await file.json()) as OpenClaudeConfig;
    const profile = (config.providerProfiles ?? []).find(
      (p) => p.provider === "gemini" && p.apiKey && p.baseUrl,
    );
    if (!profile || !profile.apiKey || !profile.baseUrl) {
      cached = null;
      return null;
    }
    cached = {
      baseUrl: profile.baseUrl.replace(/\/$/, ""),
      apiKey: profile.apiKey,
    };
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

/** Call this after the user edits their provider profiles so the cache refreshes. */
export function invalidateGeminiCliProfileCache(): void {
  cached = undefined;
}
