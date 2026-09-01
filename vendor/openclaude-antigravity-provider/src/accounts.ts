/**
 * accounts.ts
 * Multi-account manager with in-memory access token cache,
 * automatic rate-limit rotation, and least-recently-used selection.
 */

import { loadAccounts, saveAccounts, type StoredAccount } from "./storage.ts";
import { refreshAccessToken, accessTokenExpired } from "./auth.ts";

interface CachedToken {
  access: string;
  expires: number;
}

// In-memory token cache — keyed by refreshToken string
const tokenCache = new Map<string, CachedToken>();

// ── Token retrieval with auto-refresh ─────────────────────────────────────────

export async function getValidAccessToken(
  account: StoredAccount,
): Promise<string> {
  const cached = tokenCache.get(account.refreshToken);
  if (cached && !accessTokenExpired(cached.expires)) {
    return cached.access;
  }
  const result = await refreshAccessToken(account.refreshToken);
  tokenCache.set(account.refreshToken, result);
  return result.access;
}

// ── Account selection (LRU, skips rate-limited/disabled) ─────────────────────

export async function getAvailableAccount(): Promise<{
  account: StoredAccount;
  index: number;
} | null> {
  const data = await loadAccounts();
  if (!data || data.accounts.length === 0) return null;

  const now = Date.now();

  const active = data.accounts
    .map((acc, index) => ({ acc, index }))
    .filter(({ acc }) => {
      if (!acc.enabled) return false;
      if (acc.rateLimitedUntil && acc.rateLimitedUntil > now) return false;
      return true;
    });

  if (active.length === 0) {
    // All limited — find the one whose limit expires soonest.
    const soonest = data.accounts
      .filter((a) => a.enabled && a.rateLimitedUntil)
      .sort((a, b) => (a.rateLimitedUntil ?? 0) - (b.rateLimitedUntil ?? 0))[0];

    if (soonest?.rateLimitedUntil) {
      const waitMs = soonest.rateLimitedUntil - now;
      // If the wait is short enough (<= 2 min), sleep and retry automatically
      // instead of crashing — mirrors the opencode-antigravity-auth plugin behavior.
      if (waitMs > 0 && waitMs <= 120_000) {
        console.log(
          `[antigravity-provider] All accounts rate-limited. Sleeping ${Math.ceil(waitMs / 1000)}s...`,
        );
        await new Promise<void>((r) => setTimeout(r, waitMs + 200)); // +200ms buffer
        return getAvailableAccount(); // retry after sleep
      }
      const waitSec = Math.ceil(waitMs / 1000);
      throw new Error(
        `All accounts are rate-limited. Next available in ${waitSec}s.`,
      );
    }
    return null;
  }

  // Pick least-recently-used
  const best = active.sort(
    (a, b) => (a.acc.lastUsed ?? 0) - (b.acc.lastUsed ?? 0),
  )[0]!;

  return { account: best.acc, index: best.index };
}

// ── Mark account rate-limited ─────────────────────────────────────────────────

export async function markAccountRateLimited(
  index: number,
  retryAfterMs: number,
): Promise<void> {
  const data = await loadAccounts();
  if (!data || !data.accounts[index]) return;
  data.accounts[index]!.rateLimitedUntil = Date.now() + retryAfterMs;
  tokenCache.delete(data.accounts[index]!.refreshToken);
  await saveAccounts(data);
}

// ── Mark account as successfully used ────────────────────────────────────────

export async function markAccountUsed(index: number): Promise<void> {
  const data = await loadAccounts();
  if (!data || !data.accounts[index]) return;
  data.accounts[index]!.lastUsed = Date.now();
  data.accounts[index]!.rateLimitedUntil = undefined;
  await saveAccounts(data);
}

export async function getAccountCount(): Promise<number> {
  const data = await loadAccounts();
  return data?.accounts.length ?? 0;
}

export async function getAllAccounts(): Promise<StoredAccount[]> {
  const data = await loadAccounts();
  return data?.accounts ?? [];
}
