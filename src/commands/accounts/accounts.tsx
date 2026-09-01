import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// Antigravity account storage (shared with the local proxy)

type StoredAccount = {
  email?: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt?: number
  lastUsed?: number
  enabled?: boolean
  rateLimitedUntil?: number
}

type AccountsFile = {
  version: number
  accounts: StoredAccount[]
  activeIndex: number
}

function accountsFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'antigravity-accounts.json')
}

async function loadAccounts(): Promise<AccountsFile | null> {
  try {
    const raw = await readFile(accountsFilePath(), 'utf8')
    return JSON.parse(raw) as AccountsFile
  } catch {
    return null
  }
}

async function saveAccounts(data: AccountsFile): Promise<void> {
  const file = accountsFilePath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2))
  await rename(tmp, file)
}

// Google OAuth (PKCE) - same flow as the plugin's auth-cli

const GOOGLE_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const GOOGLE_CLIENT_SECRET = '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'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const OAUTH_CALLBACK_PORT = 51121
const REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/oauth-callback`
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ')

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // PowerShell Start-Process keeps the full URL intact (cmd's `start`
      // would split it at every '&').
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process "${url}"`], {
        stdio: 'ignore',
        detached: true,
      }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    }
  } catch {
    // Browser launch failure is non-fatal - the URL is shown in the dialog.
  }
}

type OAuthResult =
  | { ok: true; email?: string }
  | { ok: false; error: string }

function waitForOAuthCallback(
  expectedState: string,
  signal: AbortSignal,
): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null
    let timer: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      server?.close()
      server = null
    }

    const onAbort = () => {
      cleanup()
      reject(new Error('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    // Hard timeout: 5 minutes
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      cleanup()
      reject(new Error('timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${OAUTH_CALLBACK_PORT}`)
        if (url.pathname !== '/oauth-callback') {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (!code || state !== expectedState) {
          res.writeHead(400)
          res.end('Invalid OAuth callback.')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<html><body style="font-family:sans-serif;padding:40px;text-align:center">' +
            '<h2>Account added!</h2><p>You can close this tab and return to OpenClaude.</p>' +
            '</body></html>',
        )
        signal.removeEventListener('abort', onAbort)
        cleanup()
        resolve({ code })
      } catch {
        // ignore malformed requests
      }
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      signal.removeEventListener('abort', onAbort)
      cleanup()
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `port ${OAUTH_CALLBACK_PORT} is busy - close the app using it and retry`
            : err.message,
        ),
      )
    })

    server.listen(OAUTH_CALLBACK_PORT, 'localhost')
  })
}

async function runAddAccountFlow(
  signal: AbortSignal,
  onUrl?: (url: string) => void,
): Promise<OAuthResult> {
  try {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = randomBytes(16).toString('hex')

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: OAUTH_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    })
    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`

    onUrl?.(authUrl)
    openBrowser(authUrl)

    const { code } = await waitForOAuthCallback(state, signal)

    const tokenParams = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    })
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
      signal,
    })
    if (!tokenRes.ok) {
      const body = await tokenRes.text()
      return { ok: false, error: `token exchange failed (${tokenRes.status}): ${body.slice(0, 200)}` }
    }
    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      id_token?: string
    }
    if (!tokens.refresh_token) {
      return { ok: false, error: 'Google did not return a refresh_token (re-run and re-consent)' }
    }

    // Decode email from id_token
    let email: string | undefined
    if (tokens.id_token) {
      try {
        const payloadB64 = tokens.id_token.split('.')[1] ?? ''
        email = (JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as { email?: string }).email
      } catch {
        // ignore decode errors
      }
    }

    // Persist (dedupe by email)
    const data = (await loadAccounts()) ?? { version: 1, accounts: [], activeIndex: 0 }
    const now = Date.now()
    const idx = email ? data.accounts.findIndex((a) => a.email === email) : -1
    if (idx >= 0) {
      data.accounts[idx] = { ...data.accounts[idx]!, refreshToken: tokens.refresh_token, lastUsed: now, enabled: true }
    } else {
      data.accounts.push({
        email,
        refreshToken: tokens.refresh_token,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      })
    }
    await saveAccounts(data)
    return { ok: true, email }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message === 'cancelled' ? 'cancelled' : message }
  }
}

// Helpers

function timeLeftStr(until: number): string {
  const ms = until - Date.now()
  if (ms <= 0) return 'expired'
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s}s left`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r > 0 ? `${m}m ${r}s left` : `${m}m left`
}

function accountStatus(a: StoredAccount): { text: string; color: string } {
  if (a.enabled === false) return { text: 'disabled', color: 'gray' }
  if (a.rateLimitedUntil && a.rateLimitedUntil > Date.now()) {
    return { text: `rate-limited (${timeLeftStr(a.rateLimitedUntil)})`, color: 'yellow' }
  }
  return { text: 'enabled', color: 'green' }
}

function dateStr(ts?: number): string {
  if (!ts) return 'unknown'
  return new Date(ts).toLocaleString()
}

// Dialog component

type View = 'list' | 'detail' | 'adding'

type Props = {
  onDone: (result?: string, options?: { display?: 'skip' | 'system' | 'user' }) => void
}

function AntigravityAccountsDialog({ onDone }: Props): React.ReactNode {
  const [view, setView] = useState<View>('list')
  const [data, setData] = useState<AccountsFile | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [proxyStatus, setProxyStatus] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const reload = React.useCallback(async () => {
    setData(await loadAccounts())
  }, [])

  useEffect(() => {
    void reload()
    // Proxy health for the subtitle (non-fatal)
    fetch('http://127.0.0.1:51122/health', { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { status?: string; accounts?: number } | null) => {
        setProxyStatus(
          j?.status === 'ok' ? `proxy running (${j.accounts ?? 0} account(s) in pool)` : 'proxy not running',
        )
      })
      .catch(() => setProxyStatus('proxy not running'))
  }, [reload])

  // OAuth flow lifecycle for the "adding" view
  useEffect(() => {
    if (view !== 'adding') return
    const controller = new AbortController()
    let disposed = false
    abortRef.current = controller
    void runAddAccountFlow(controller.signal, (url) => setAuthUrl(url)).then((result) => {
      if (disposed) return
      if (result.ok) {
        setStatusMsg(
          result.email ? `Account added: ${result.email}` : 'Account added',
        )
        void reload().then(() => setView('list'))
      } else if (result.error === 'cancelled') {
        setStatusMsg('Add account cancelled')
        setView('list')
      } else {
        setStatusMsg(`Add account failed: ${result.error}`)
        setView('list')
      }
    })
    return () => {
      disposed = true
      controller.abort()
      abortRef.current = null
    }
  }, [view, reload])

  const accounts = data?.accounts ?? []

  const handleCancel = () => {
    if (view === 'detail') {
      setView('list')
      return
    }
    if (view === 'adding') {
      abortRef.current?.abort()
      return
    }
    onDone('Antigravity accounts dismissed', { display: 'system' })
  }

  // List view
  if (view === 'list') {
    const options: OptionWithDescription<string>[] = []

    accounts.forEach((acc, i) => {
      const st = accountStatus(acc)
      const label = acc.email ?? `Account ${i + 1}`
      const lastUsed = acc.lastUsed ? ` - used ${dateStr(acc.lastUsed)}` : ''
      options.push({
        label,
        value: `account:${i}`,
        description: `${st.text}${lastUsed}`,
        color: st.color,
      })
    })

    options.push({ label: 'Add new Google account', value: '__add__', description: 'opens browser for Google sign-in' })
    const limitedCount = accounts.filter((a) => a.rateLimitedUntil && a.rateLimitedUntil > Date.now()).length
    options.push({
      label: 'Clear all rate limits',
      value: '__clear__',
      description: limitedCount > 0 ? `${limitedCount} account(s) currently limited` : 'nothing limited right now',
    })
    options.push({ label: 'Exit', value: '__exit__', description: 'close this dialog' })

    return (
      <Dialog
        title="Antigravity Accounts"
        subtitle={`${accounts.length} account(s) - ${proxyStatus ?? 'checking proxy...'}`}
        onCancel={handleCancel}
        showNavigationHint
      >
        <Box flexDirection="column" gap={1}>
          {statusMsg && <Text dimColor>{statusMsg}</Text>}
          <Select
            options={options}
            visibleOptionCount={Math.max(options.length, 4)}
            onChange={async (value: string) => {
              if (value === '__exit__') {
                onDone('Antigravity accounts dismissed', { display: 'system' })
                return
              }
              if (value === '__add__') {
                setStatusMsg(null)
                setAuthUrl(null)
                setView('adding')
                return
              }
              if (value === '__clear__') {
                if (data) {
                  for (const a of data.accounts) a.rateLimitedUntil = undefined
                  await saveAccounts(data)
                  await reload()
                  setStatusMsg('Rate limits cleared')
                }
                return
              }
              if (value.startsWith('account:')) {
                setSelectedIdx(Number(value.split(':')[1]))
                setStatusMsg(null)
                setView('detail')
              }
            }}
            onCancel={handleCancel}
          />
        </Box>
      </Dialog>
    )
  }

  // Detail view
  if (view === 'detail') {
    const acc = accounts[selectedIdx]
    if (!acc) {
      // Defensive: account vanished (e.g. file changed externally). Esc returns to the list.
      return (
        <Dialog title="Antigravity Accounts" subtitle="selected account no longer exists" onCancel={() => setView('list')}>
          <Box flexDirection="column" gap={1}>
            <Text dimColor>The selected account is no longer in the pool.</Text>
            <Text dimColor italic>
              Esc to go back
            </Text>
          </Box>
        </Dialog>
      )
    }
    const st = accountStatus(acc)
    const options: OptionWithDescription<string>[] = [
      {
        label: acc.enabled === false ? 'Enable account' : 'Disable account',
        value: 'toggle',
        description: acc.enabled === false ? 'include in rotation again' : 'exclude from rotation',
      },
    ]
    if (acc.rateLimitedUntil && acc.rateLimitedUntil > Date.now()) {
      options.push({
        label: 'Clear rate limit',
        value: 'clear',
        description: `limited - ${timeLeftStr(acc.rateLimitedUntil)}`,
      })
    }
    options.push({ label: 'Delete account', value: 'delete', description: 'remove from the pool' })
    options.push({ label: 'Back', value: 'back', description: 'return to account list' })

    return (
      <Dialog
        title={`Account: ${acc.email ?? `#${selectedIdx + 1}`}`}
        subtitle={`status: ${st.text} - added ${dateStr(acc.addedAt)}`}
        onCancel={handleCancel}
        showNavigationHint
      >
        <Box flexDirection="column" gap={1}>
          {statusMsg && <Text dimColor>{statusMsg}</Text>}
          <Select
            options={options}
            visibleOptionCount={options.length}
            onChange={async (value: string) => {
              if (value === 'back') {
                setView('list')
                setStatusMsg(null)
                return
              }
              if (!data) return
              if (value === 'toggle') {
                const target = data.accounts[selectedIdx]!
                target.enabled = target.enabled === false ? true : false
                await saveAccounts(data)
                await reload()
                setStatusMsg(target.enabled ? 'Account enabled' : 'Account disabled')
                return
              }
              if (value === 'clear') {
                data.accounts[selectedIdx]!.rateLimitedUntil = undefined
                await saveAccounts(data)
                await reload()
                setStatusMsg('Rate limit cleared')
                return
              }
              if (value === 'delete') {
                const email = data.accounts[selectedIdx]!.email ?? `#${selectedIdx + 1}`
                data.accounts.splice(selectedIdx, 1)
                if (data.activeIndex >= data.accounts.length) data.activeIndex = 0
                await saveAccounts(data)
                await reload()
                setStatusMsg(`Deleted ${email}`)
                setView('list')
              }
            }}
            onCancel={handleCancel}
          />
        </Box>
      </Dialog>
    )
  }

  // Adding view (OAuth in progress)
  return (
    <Dialog
      title="Add Google Account"
      subtitle="complete the sign-in in your browser"
      onCancel={handleCancel}
    >
      <Box flexDirection="column" gap={1}>
        <LoadingState message="Waiting for Google sign-in..." subtitle="a browser window has been opened" />
        {authUrl && (
          <Text dimColor wrap="truncate-end">
            URL: {authUrl}
          </Text>
        )}
        <Text dimColor italic>
          Esc to cancel
        </Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context) => {
  return <AntigravityAccountsDialog onDone={onDone} />
}
