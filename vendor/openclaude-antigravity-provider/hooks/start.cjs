#!/usr/bin/env node
// start.js - Universal SessionStart hook for the Antigravity proxy.
// Runs on Node.js (no Bun/PowerShell/bash required) so the same hook works
// on Windows, macOS, and Linux after `npm install -g @xkei/openclaude`.
//
// Picks the pre-compiled platform binary; falls back to `bun run src/server.ts`
// if the binary is missing (e.g. unsupported arch or source checkout).
// ponytail: no retry on health-wait timeout; upgrade path: exponential backoff.
// ponytail: proxy is a detached daemon with no SessionEnd hook — it outlives
// sessions (safe for concurrent ones) and dies on reboot/manual kill only.
// Upgrade path: reference-counted shutdown via a session registry file.

'use strict';
const { spawnSync, spawn } = require('child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
const http = require('http');

const PROXY_PORT = 51122;
const HEALTH_URL = `http://127.0.0.1:${PROXY_PORT}/health`;
const PROJECT_ROOT = dirname(__dirname);           // vendor/openclaude-antigravity-provider
const BIN_DIR = join(PROJECT_ROOT, 'bin');

// PID file in ~/.openclaude/
const pidDir = join(process.env.HOME || process.env.USERPROFILE || '', '.openclaude');
const PID_FILE = join(pidDir, 'antigravity-proxy.pid');

// ── Binary selection ─────────────────────────────────────────────────────────
const PLATFORM_MAP = {
  'win32-x64':   'antigravity-proxy-win-x64.exe',
  'linux-x64':   'antigravity-proxy-linux-x64',
  'linux-arm64': 'antigravity-proxy-linux-arm64',
  'darwin-x64':  'antigravity-proxy-darwin-x64',
  'darwin-arm64':'antigravity-proxy-darwin-arm64',
};

function resolveLauncher() {
  const key = `${process.platform}-${process.arch}`;
  const bin = PLATFORM_MAP[key];
  if (bin) {
    const full = join(BIN_DIR, bin);
    if (existsSync(full)) return { cmd: full, args: [] };
  }
  // Fallback: bun run source (dev / unsupported arch)
  const serverTs = join(PROJECT_ROOT, 'src', 'server.ts');
  if (!existsSync(serverTs)) return null;
  for (const bun of ['bun', join(process.env.LOCALAPPDATA || '', 'Kiro-Cli', 'bun.exe')]) {
    try {
      if (spawnSync(bun, ['--version'], { timeout: 2000 }).status === 0)
        return { cmd: bun, args: ['run', serverTs] };
    } catch {}
  }
  return null;
}

// ── Health check (sync via http) ─────────────────────────────────────────────
function isHealthy() {
  return new Promise(resolve => {
    const req = http.get(HEALTH_URL, { timeout: 1000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body).status === 'ok'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(ms = 8000, interval = 400) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (await isHealthy()) {
    console.log(`[antigravity-provider] Proxy ready -> http://127.0.0.1:${PROXY_PORT}/v1`);
    return;
  }

  const launcher = resolveLauncher();
  if (!launcher) {
    console.warn('[antigravity-provider] No launcher found. Build with: bun run build');
    return;
  }

  try { mkdirSync(pidDir, { recursive: true }); } catch {}

  const child = spawn(launcher.cmd, launcher.args, {
    detached: true,
    stdio: 'ignore',
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });
  child.unref();

  try { writeFileSync(PID_FILE, String(child.pid)); } catch {}

  const healthy = await waitHealthy();
  if (healthy) {
    console.log(`[antigravity-provider] Proxy ready -> http://127.0.0.1:${PROXY_PORT}/v1`);
    // Pre-warm model list (best-effort)
    http.get(`http://127.0.0.1:${PROXY_PORT}/v1/models`, () => {}).on('error', () => {});
  } else {
    console.warn('[antigravity-provider] Proxy not healthy yet (slow start?). It may come up shortly.');
  }

  // ── Provider config injection (idempotent, never fails) ────────────────────
  const injector = join(PROJECT_ROOT, 'hooks', 'inject-provider.cjs');
  if (existsSync(injector)) {
    const inj = spawnSync(process.execPath, [injector], { timeout: 10000, encoding: 'utf8' });
    if (inj.stdout && inj.stdout.trim()) console.log(inj.stdout.trim());
  }
})();
