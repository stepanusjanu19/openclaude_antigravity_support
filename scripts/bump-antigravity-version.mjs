import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const raw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)

const current = String(pkg.version ?? '')
const baseMatch = current.match(/^(\d+\.\d+\.\d+)/)
if (!baseMatch) {
  console.error(`Cannot determine base version from "${current}"`)
  process.exit(1)
}
const base = baseMatch[1]

const published = (() => {
  try {
    const stdout = execFileSync(
      'npm',
      ['view', pkg.name, 'versions', '--json'],
      { encoding: 'utf8', stderr: 'pipe', timeout: 30_000 },
    )
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
})()

const prefix = `${base}-antigravity.`
let highest = 0
for (const v of published) {
  if (typeof v === 'string' && v.startsWith(prefix)) {
    const n = Number.parseInt(v.slice(prefix.length), 10)
    if (Number.isInteger(n) && n > highest) highest = n
  }
}

const next = highest + 1
const newVersion = `${base}-antigravity.${next}`

console.log(`Package:  ${pkg.name}`)
console.log(`Base:     ${base}`)
console.log(`Found:    ${highest > 0 ? `${prefix}${highest}` : 'no prior -antigravity versions'}`)
console.log(`Next:     ${newVersion}${dryRun ? ' (dry run, not written)' : ''}`)

if (!dryRun) {
  pkg.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  const githubEnv = process.env.GITHUB_ENV
  if (githubEnv) {
    writeFileSync(githubEnv, `PUBLISHED_VERSION=${newVersion}\n`, { flag: 'a' })
  }
}
