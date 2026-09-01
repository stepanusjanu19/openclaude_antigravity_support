/**
 * auth-cli.ts
 * Interactive first-time Google OAuth login for OpenClaude Antigravity Provider.
 * Run: bun run src/auth-cli.ts
 */

import { loadAccounts, saveAccounts, type StoredAccount } from "./storage.ts";
import {
  buildAuthorizationUrl,
  waitForOAuthCallback,
  exchangeCodeForTokens,
} from "./auth.ts";
import { ACCOUNTS_FILE } from "./constants.ts";

async function openBrowser(url: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      // cmd.exe splits URLs at '&' — use PowerShell Start-Process instead
      // which correctly passes the full URL as a single string argument.
      Bun.spawn(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
          `Start-Process "${url.replace(/"/g, '`"')}"`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // Browser open failed — user will copy URL manually
  }
}

async function main(): Promise<void> {
  console.log("\n=== OpenClaude Antigravity Auth ===\n");

  const existing = await loadAccounts();
  if (existing && existing.accounts.length > 0) {
    console.log(`Found ${existing.accounts.length} existing account(s):`);
    for (const acc of existing.accounts) {
      const status = acc.enabled ? "enabled" : "disabled";
      console.log(`  - ${acc.email ?? "unknown"} [${status}]`);
    }
    console.log("\nAdding / re-authenticating...\n");
  }

  const { url, verifier, state } = await buildAuthorizationUrl();

  console.log("Opening your browser for Google sign-in...");
  console.log("If the browser does not open, paste this URL manually:\n");
  console.log(url);
  console.log();

  await openBrowser(url);

  console.log(
    `Waiting for OAuth callback on http://localhost:51121/oauth-callback ...\n`,
  );

  let code: string;
  try {
    const result = await waitForOAuthCallback(state);
    code = result.code;
  } catch (err: unknown) {
    console.error(
      "OAuth callback failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  console.log("Exchanging authorization code for tokens...");

  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens(code, verifier);
  } catch (err: unknown) {
    console.error(
      "Token exchange failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  const data = existing ?? { version: 1, accounts: [] as StoredAccount[], activeIndex: 0 };

  // Update existing account if same email, otherwise add new
  const existingIdx = tokens.email
    ? data.accounts.findIndex((a) => a.email === tokens.email)
    : -1;

  const now = Date.now();
  const newAccount: StoredAccount = {
    email: tokens.email,
    refreshToken: tokens.refresh_token,
    addedAt: existingIdx >= 0 ? (data.accounts[existingIdx]!.addedAt) : now,
    lastUsed: now,
    enabled: true,
  };

  if (existingIdx >= 0) {
    data.accounts[existingIdx] = newAccount;
    console.log(`\nUpdated existing account: ${tokens.email ?? "unknown"}`);
  } else {
    data.accounts.push(newAccount);
    console.log(`\nAdded new account: ${tokens.email ?? "unknown"}`);
  }

  await saveAccounts(data);

  console.log(`\nAccounts saved to: ${ACCOUNTS_FILE}`);
  console.log(`Total accounts: ${data.accounts.length}`);
  console.log("\nStart the proxy server with:");
  console.log("  bun run src/server.ts\n");
}

main().catch((err: unknown) => {
  console.error(
    "Fatal error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
