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
for (const { flag, out } of TARGETS) {
  process.stdout.write(`Building ${out} (${flag})... `);
  const t = Date.now();
  execFileSync('bun', ['build', '--compile', entry, `--target=${flag}`, `--outfile=${out}`], {
    cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
  });
  console.log(`done (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
console.log('All proxy binaries built.');
