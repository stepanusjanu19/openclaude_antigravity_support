import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const raw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)

const current = String(pkg.version ?? '')
const baseMatch = current.match(/^(\d+)\.(\d+)\.(\d+)(?=[-]|$)/)
if (!baseMatch) {
  console.error(`Cannot determine MAJOR.MINOR.PATCH from "${current}"`)
  process.exit(1)
}
const major = Number(baseMatch[1])
const minor = Number(baseMatch[2])
const pkgPatch = Number(baseMatch[3])
const family = `${major}.${minor}`

const published = (() => {
  try {
    const stdout = execFileSync(
      'npm',
      ['view', pkg.name, 'versions', '--json'],
      { encoding: 'utf8', stderr: 'pipe', timeout: 30_000 },
    )
    const parsed = JSON.parse(stdout)
    return new Set(Array.isArray(parsed) ? parsed : [parsed])
  } catch {
    return new Set()
  }
})()

const antigravityPatchRe = new RegExp(`^${family}\\.(\\d+)-antigravity(?:[.-].*)?$`)
let highest = -1
for (const v of published) {
  const m = typeof v === 'string' ? v.match(antigravityPatchRe) : null
  if (m) {
    const p = Number(m[1])
    if (Number.isInteger(p) && p > highest) highest = p
  }
}

let patch = pkgPatch > highest ? pkgPatch : highest + 1
while (published.has(`${family}.${patch}-antigravity`)) {
  patch += 1
}
const newVersion = `${family}.${patch}-antigravity`

const priorInfo =
  highest >= 0
    ? `highest published -antigravity patch in ${family}.X: ${highest}`
    : `no -antigravity releases in ${family}.X yet`

console.log(`Package:  ${pkg.name}`)
console.log(`Base:     ${major}.${minor}.${pkgPatch} (from package.json)`)
console.log(`Registry: ${priorInfo}`)
console.log(`Next:     ${newVersion}${dryRun ? ' (dry run, not written)' : ''}`)

if (!dryRun) {
  pkg.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  const githubEnv = process.env.GITHUB_ENV
  if (githubEnv) {
    writeFileSync(githubEnv, `PUBLISHED_VERSION=${newVersion}\n`, { flag: 'a' })
  }
}
