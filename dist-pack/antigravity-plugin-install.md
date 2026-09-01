# OpenClaude + Antigravity Provider — Installation Guide

Step-by-step instructions for installing the bundled OpenClaude package with
the Google Antigravity provider plugin. After installation you can use
**Gemini 3 Pro/Flash** and **Claude Sonnet 4.6 / Opus 4.6** through your
personal Google accounts, with automatic multi-account rotation and no
free-tier rate limits.

---

## What you get

| Component | Description |
|---|---|
| **OpenClaude CLI** | Claude Code-style agent CLI (`openclaude` command) |
| **`/accounts` command** | Built-in account manager (add / enable / disable / delete Google accounts, clear rate limits) |
| **Antigravity provider plugin** | Auto-starting local proxy (`localhost:51122`) bridging OpenClaude to Google's Antigravity API |
| **Zero-config bootstrap** | The plugin registers itself on first launch — no manual settings edits |

---

## Requirements

- **OS:** Windows 10/11 (the bundled proxy is a Windows executable; hooks are
  `.bat`/`.ps1`).
- **Node.js 20+** (or Bun 1.0+) — runs the CLI.
- One or more **Google accounts** (personal Gmail accounts work).
- Optional: **Bun** — only needed if you want to rebuild the proxy from source.

---

## Step 1 — Install the package

Install from the bundled tarball (`gitlawb-openclaude-0.30.0.tgz`):

```powershell
npm install -g .\gitlawb-openclaude-0.30.0.tgz
```

or with Bun:

```powershell
bun install -g .\gitlawb-openclaude-0.30.0.tgz
```

> If you are installing from a source checkout instead, see
> [Appendix A](#appendix-a--installing-from-a-source-checkout).

## Step 2 — Verify the CLI works

```powershell
openclaude --version
```

Expected output:

```
0.30.0 (OpenClaude)
```

> If `openclaude` is not found, restart your terminal so the global `bin`
> directory is on `PATH`.

## Step 3 — First launch (plugin self-registration)

Start OpenClaude in any project folder:

```powershell
cd C:\your\project
openclaude
```

On boot, OpenClaude automatically registers the bundled plugin by writing
these entries into `~\.openclaude\settings.json` (only if missing — your own
edits are never overwritten):

```json
{
  "enabledPlugins": {
    "openclaude-antigravity-provider@openclaude-antigravity-provider": true
  },
  "extraKnownMarketplaces": {
    "openclaude-antigravity-provider": {
      "source": { "source": "directory", "path": "…\\vendor\\openclaude-antigravity-provider" }
    }
  }
}
```

**Verify:** inside OpenClaude run `/plugin` — `openclaude-antigravity-provider`
should be listed as enabled.

## Step 4 — Add a Google account

1. Inside OpenClaude, type:
   ```
   /accounts
   ```
2. Select **Add new Google account** — a browser window opens for Google
   sign-in.
3. Sign in with your Google account and approve the consent prompt.
4. The browser shows *"Account added!"* — return to OpenClaude. The account
   now appears in the list as **enabled**.

Repeat for each account you want in the rotation pool (LRU rotation — the
least-recently-used healthy account serves each request).

> Accounts are stored in `~\.openclaude\antigravity-accounts.json`.
> Refresh tokens never leave your machine.

## Step 5 — Select a model and start coding

```
/model
```

Pick one of the Antigravity models (auto-discovered from the proxy):

| Model ID | Served as |
|---|---|
| `antigravity-gemini-3.1-pro` | Gemini 3.1 Pro (thinking: low) |
| `antigravity-gemini-3-pro` | Gemini 3 Pro (thinking: low) |
| `antigravity-gemini-3-flash` | Gemini 3 Flash |
| `gemini-2.5-pro` / `gemini-2.5-flash` | Gemini 2.5 family |
| `antigravity-claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `antigravity-claude-opus-4-6-thinking` | Claude Opus 4.6 (thinking) |

Then just chat — the proxy auto-starts with every session and shuts down when
OpenClaude exits.

---

## How it works

```
OpenClaude ──OpenAI-compatible──▶ local proxy (127.0.0.1:51122)
                                      │  picks healthy Google account (LRU)
                                      │  refreshes OAuth access token
                                      ▼
                      Google Antigravity daily sandbox
                      (agent-type requests → unlimited quota)
```

- **Why no rate limits:** requests are sent Antigravity-Manager-style
  (synthetic project + `requestType: "agent"` + bare tier-suffixed model
  names) to the daily sandbox endpoint, which routes them into the
  agent quota pool instead of the per-account free tier.
- **Rotation:** on a 429 the account is marked rate-limited and the next
  account is tried. If *all* accounts are limited and the longest wait is
  under 2 minutes, the proxy silently sleeps it out and retries.
- **Gemini-CLI fallback (optional):** if every account is exhausted on a
  Gemini model, the proxy forwards the request to the official Gemini API
  using the API key from your `~\.openclaude.json` provider profile named
  **"Google AI / Gemini"** (if configured). Claude models are never rerouted —
  they return the 429 to OpenClaude as normal.

---

## Managing accounts (`/accounts` reference)

| Action | Effect |
|---|---|
| Select an account | Shows status, added/used dates, per-account actions |
| Enable / Disable | Toggles inclusion in the rotation pool |
| Clear rate limit | Removes an account's cooldown immediately |
| Delete account | Removes it from the pool |
| Clear all rate limits | Removes every cooldown |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `openclaude` not found | Restart terminal (PATH refresh) |
| Models not in `/model` list | Check the proxy: `Invoke-RestMethod http://127.0.0.1:51122/health` — expect `{"status":"ok","accounts":N,...}`. If not running, restart OpenClaude (the SessionStart hook relaunches it) |
| Proxy slow to start | First launch may be delayed by antivirus scanning the exe (hook waits up to ~8 s; it keeps starting in the background) |
| Port 51122 busy | Stop the stale process: `Get-Process antigravity-proxy \| Stop-Process -Force`, then restart OpenClaude |
| OAuth add-account fails "port 51121 busy" | Another add-account flow is in progress or a stale listener holds the port — close it and retry |
| 429 errors return | Rare on the sandbox path. Open `/accounts` → **Clear all rate limits**, or wait — the proxy auto-sleeps short cooldowns |
| Settings not auto-written | File may be policy-locked; add the two entries from Step 3 manually or register via `/plugin` |

## Disable / uninstall

**Disable the plugin** (bootstrap will not re-enable it):

```jsonc
// ~\.openclaude\settings.json
"enabledPlugins": {
  "openclaude-antigravity-provider@openclaude-antigravity-provider": false
}
```

**Uninstall the package:**

```powershell
npm uninstall -g @gitlawb/openclaude
```

---

## Appendix A — Installing from a source checkout

Requires Bun.

```powershell
git clone <this-repo>
cd openclaude
bun install

# Build the CLI
bun run build

# Build the bundled proxy executable
bun run build:proxy

# Produce the installable tarball
npm pack --pack-destination dist-pack
npm install -g .\dist-pack\gitlawb-openclaude-0.30.0.tgz
```

**Standalone plugin only** (existing OpenClaude install): register the
`vendor/openclaude-antigravity-provider` directory as a marketplace in
`~\.openclaude\settings.json` (same JSON as Step 3), or copy the folder
anywhere and point `path` at it, then enable it via `/plugin`.
