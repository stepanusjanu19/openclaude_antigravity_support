/**
 * inject-provider.js
 * Ensures OpenClaude's provider configuration points at the local
 * Antigravity proxy (http://localhost:51122/v1).
 *
 * Idempotent: only writes when configuration is missing/mispointed.
 * Creates .plugin-bak backups before any write. Exits 0 always.
 *
 * Run via: bun hooks/inject-provider.js  (or: node hooks/inject-provider.js)
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir();
const OC_DIR = path.join(HOME, ".openclaude");
const PROFILE_PATH = path.join(OC_DIR, ".openclaude-profile.json");
const MAIN_PATH = path.join(HOME, ".openclaude.json");

const BASE_URL = "http://localhost:51122/v1";
const MODEL = "antigravity-claude-sonnet-4-6";

function backup(file) {
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, file + ".plugin-bak");
    }
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const tmp = file + ".plugin-tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

try {
  // ── 1. ~/.openclaude/.openclaude-profile.json (active profile env) ──────────
  let needProfile = true;
  const existing = readJson(PROFILE_PATH);
  if (
    existing &&
    existing.env &&
    typeof existing.env.OPENAI_BASE_URL === "string" &&
    existing.env.OPENAI_BASE_URL.includes(":51122")
  ) {
    needProfile = false;
  }

  if (needProfile) {
    backup(PROFILE_PATH);
    fs.mkdirSync(OC_DIR, { recursive: true });
    writeJson(PROFILE_PATH, {
      profile: "openai",
      env: {
        OPENAI_BASE_URL: BASE_URL,
        OPENAI_MODEL: MODEL,
        OPENAI_AUTH_HEADER: "dummy",
        OPENAI_AUTH_SCHEME: "raw",
      },
      createdAt: existing && existing.createdAt ? existing.createdAt : new Date().toISOString(),
    });
    console.log("[antigravity-provider] injected provider profile (.openclaude-profile.json)");
  }

  // ── 2. ~/.openclaude.json providerProfiles entry (only when absent) ────────
  // Never overrides the user's active provider if an entry already exists —
  // they may have deliberately switched. Injection is for fresh setups only.
  if (fs.existsSync(MAIN_PATH)) {
    const main = readJson(MAIN_PATH);
    if (main) {
      const profiles = Array.isArray(main.providerProfiles) ? main.providerProfiles : [];
      const has = profiles.some(
        (p) => p && typeof p.baseUrl === "string" && p.baseUrl.includes(":51122"),
      );

      if (!has) {
        backup(MAIN_PATH);
        const id = "provider_antigravity_local";
        profiles.push({
          id: id,
          name: "Antigravity (Local Proxy)",
          provider: "custom",
          baseUrl: BASE_URL,
          model: MODEL,
          authHeader: "dummy",
          authScheme: "raw",
        });
        main.providerProfiles = profiles;
        main.activeProviderProfileId = id;
        writeJson(MAIN_PATH, main);
        console.log("[antigravity-provider] injected providerProfiles entry (.openclaude.json)");
      }
    }
  }
} catch (e) {
  // Never fail the hook because of injection problems.
  console.error("[antigravity-provider] provider inject skipped: " + (e && e.message));
}

process.exit(0);
