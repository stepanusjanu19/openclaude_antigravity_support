#!/usr/bin/env node
// scripts/build-proxy-all.mjs
// Compiles the Antigravity proxy for all supported platforms.
// Runs targets in parallel; prints a summary table.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'vendor', 'openclaude-antigravity-provider');
const entry = 'src/server.ts';

const TARGETS = [
  { flag: 'bun-windows-x64', out: 'bin/antigravity-proxy-win-x64.exe' },
  { flag: 'bun-linux-x64',   out: 'bin/antigravity-proxy-linux-x64'   },
  { flag: 'bun-linux-arm64', out: 'bin/antigravity-proxy-linux-arm64'  },
  { flag: 'bun-darwin-x64',  out: 'bin/antigravity-proxy-darwin-x64'  },
  { flag: 'bun-darwin-arm64',out: 'bin/antigravity-proxy-darwin-arm64' },
];

// ponytail: sequential not parallel; bun cross-compile is CPU-bound and parallel
// saturates small CI runners. Upgrade path: Promise.all() when runners have ≥8 cores.
// ponytail: all 5 binaries in one tarball (~175MB) — every install downloads all
// platforms. Upgrade path: per-platform optionalDependencies packages when
// install size matters.
// Retry wrapper: bun cross-compile downloads the target's base executable on
// first use; CI runners hit transient "Failed to extract executable" network
// failures. 3 attempts, 5s backoff.
function runWithRetry(args, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync('bun', args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`\n${label} failed (attempt ${attempt}/3), retrying in 5s...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
  }
}

for (const { flag, out } of TARGETS) {
  process.stdout.write(`Building ${out} (${flag})... `);
  const t = Date.now();
  runWithRetry(['build', '--compile', entry, `--target=${flag}`, `--outfile=${out}`], out);
  console.log(`done (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
console.log('All proxy binaries built.');
