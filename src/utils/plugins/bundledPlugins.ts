/**
 * bundledPlugins.ts
 *
 * Zero-config registration of plugins bundled inside the OpenClaude package
 * itself (vendor/<name>). Runs once at CLI boot, BEFORE any settings read, so
 * the normal plugin machinery (settingsSync → reconciler → hook loading)
 * picks the bundled plugin up as if the user had configured it by hand.
 *
 * Currently bundles: openclaude-antigravity-provider
 *   - OpenAI-compatible local proxy (Google Antigravity OAuth, daily-sandbox
 *     agent quota, multi-account rotation, Gemini-CLI fallback)
 *   - Registers the /accounts command (src/commands/accounts)
 *
 * Behavior:
 *   - No-op when the vendor directory is absent (e.g. upstream installs).
 *   - Idempotent: only fills in missing entries; never overrides a user's
 *     own configuration, and never re-enables a plugin the user disabled.
 *   - Writes the user settings.json directly (raw fs) because this runs
 *     before the settings utility has built any cache.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getClaudeConfigHomeDir } from '../envUtils.js'

const BUNDLED_PLUGIN_NAME = 'openclaude-antigravity-provider'
const BUNDLED_PLUGIN_ID = `${BUNDLED_PLUGIN_NAME}@${BUNDLED_PLUGIN_NAME}`

interface UserSettings {
  enabledPlugins?: Record<string, boolean>
  extraKnownMarketplaces?: Record<
    string,
    { source: { source: string; path?: string; repo?: string } }
  >
  [key: string]: unknown
}

/**
 * Resolve the bundled plugin root relative to this module's location.
 * Works for the built layout (dist/cli.mjs → <pkg>/vendor/...) and the
 * source layout (src/utils/plugins/... → <repo>/vendor/...), plus a
 * process.argv[1] fallback for exotic loaders.
 */
export function resolveBundledPluginRoot(): string | null {
  const candidates: string[] = []

  const selfDirCandidates: string[] = []
  try {
    selfDirCandidates.push(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // import.meta.url unavailable in exotic runtimes
  }
  if (process.argv[1]) selfDirCandidates.push(dirname(process.argv[1]!))

  for (const base of selfDirCandidates) {
    candidates.push(join(base, '..', 'vendor', BUNDLED_PLUGIN_NAME)) // dist layout
    candidates.push(join(base, '..', '..', '..', 'vendor', BUNDLED_PLUGIN_NAME)) // src/utils/plugins layout
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.claude-plugin', 'marketplace.json'))) {
      return candidate
    }
  }
  return null
}

function userSettingsPath(): string {
  return join(getClaudeConfigHomeDir(), 'settings.json')
}

/**
 * Ensure the bundled plugin is declared + enabled in user settings.
 * Returns true when the settings file was modified.
 */
export function ensureBundledPluginRegistered(): boolean {
  const pluginRoot = resolveBundledPluginRoot()
  if (!pluginRoot) return false

  let settings: UserSettings = {}
  const settingsPath = userSettingsPath()
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as UserSettings
  } catch {
    settings = {}
  }

  // Respect an explicit user opt-out.
  if (settings.enabledPlugins?.[BUNDLED_PLUGIN_ID] === false) return false

  const marketplaceEntry = {
    source: { source: 'directory', path: pluginRoot },
  }

  const enabledMissing =
    settings.enabledPlugins?.[BUNDLED_PLUGIN_ID] === undefined
  const marketplaceMissing =
    settings.extraKnownMarketplaces?.[BUNDLED_PLUGIN_NAME] === undefined

  if (!enabledMissing && !marketplaceMissing) return false

  const updated: UserSettings = {
    ...settings,
    enabledPlugins: {
      ...(settings.enabledPlugins ?? {}),
      ...(enabledMissing ? { [BUNDLED_PLUGIN_ID]: true } : {}),
    },
    extraKnownMarketplaces: {
      ...(settings.extraKnownMarketplaces ?? {}),
      ...(marketplaceMissing ? { [BUNDLED_PLUGIN_NAME]: marketplaceEntry } : {}),
    },
  }

  try {
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(updated, null, 2))
    return true
  } catch {
    // Read-only home, policy-locked settings, etc. — silently skip; the
    // user can still register the plugin manually via /plugin.
    return false
  }
}
