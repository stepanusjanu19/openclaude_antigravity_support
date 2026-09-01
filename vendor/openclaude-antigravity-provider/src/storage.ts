/**
 * storage.ts
 * Reads/writes account data using Bun.file() and Bun.write().
 * Storage path: ~/.openclaude/antigravity-accounts.json
 */

import { mkdirSync, existsSync } from "node:fs";
import { OPENCLAUDE_CONFIG_DIR, ACCOUNTS_FILE } from "./constants.ts";

export interface StoredAccount {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  enabled: boolean;
  rateLimitedUntil?: number;
  cachedQuotaUpdatedAt?: number;
}

export interface AccountsFile {
  version: number;
  accounts: StoredAccount[];
  activeIndex: number;
}

function ensureConfigDir(): void {
  if (!existsSync(OPENCLAUDE_CONFIG_DIR)) {
    mkdirSync(OPENCLAUDE_CONFIG_DIR, { recursive: true });
  }
}

export async function loadAccounts(): Promise<AccountsFile | null> {
  ensureConfigDir();
  const file = Bun.file(ACCOUNTS_FILE);
  const exists = await file.exists();
  if (!exists) return null;
  try {
    return await file.json() as AccountsFile;
  } catch {
    return null;
  }
}

export async function saveAccounts(data: AccountsFile): Promise<void> {
  ensureConfigDir();
  await Bun.write(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

export async function clearAccounts(): Promise<void> {
  const file = Bun.file(ACCOUNTS_FILE);
  if (await file.exists()) {
    await Bun.write(ACCOUNTS_FILE, "");
  }
}
