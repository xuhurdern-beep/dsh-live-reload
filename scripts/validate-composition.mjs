/**
 * Offline validation: does dsh-live-reload's fresh recomposition reproduce the
 * launcher's own boot composition?
 *
 * Runs `dsh --profile <name> --dump-config` (a boot-free process that prints
 * the composed entry list) and compares it row-by-row against the plugin's
 * `composeFresh` output. The dump omits the two boot-only overlays
 * (agent-presets shipped-roots, telemetry switch), so those rows are compared
 * with the overlay expectations asserted explicitly.
 *
 * Usage:
 *   node scripts/validate-composition.mjs [profile] [--patch file...]
 * Default profile: web.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const profile = process.argv[2] ?? 'web'
const patchFiles = []
for (let i = 3; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--patch') { patchFiles.push(process.argv[i + 1]); i += 1 }
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profile)

/** Bare-specifier resolution from the installation fallback (mirrors the plugin's loader). */
const fallbackRequire = createRequire(join(home, 'profiles', 'node_modules', 'anchor.js'))
const yaml = (await import(pathToFileURL(fallbackRequire.resolve('js-yaml')).href)).default
const { composeEntries } = await import(pathToFileURL(fallbackRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
const { entryListSchema } = await import(pathToFileURL(fallbackRequire.resolve('@deepseek-ai/cordis-plugin-include')).href)
const { composeFresh } = await import(new URL('../src/index.js', import.meta.url).href)

// The dsh app package (the launcher) resolves through the same fallback.
const appDir = dirname(fallbackRequire.resolve('@deepseek-ai/dsh/package.json'))
const checkout = dirname(appDir)
const bin = existsSync(join(appDir, 'lib', 'bin.js'))
  ? join(appDir, 'lib', 'bin.js')
  : join(appDir, 'src', 'bin.ts')

/** Run the launcher's own dump for the same layers (stdout redirected to a temp file). */
function runDump() {
  const nodeArgs = []
  if (bin.endsWith('.ts')) nodeArgs.push('--import', 'tsx')
  nodeArgs.push(bin, '--profile', profile, '--dump-config')
  for (const file of patchFiles) nodeArgs.push('--patch', file)
  const outFile = join(tmpdir(), `dsh-live-reload-dump-${process.pid}.yml`)
  const fd = openSync(outFile, 'w')
  try {
    execFileSync(process.execPath, nodeArgs, {
      cwd: checkout,
      stdio: ['ignore', fd, 'inherit'],
    })
    const text = readFileSync(outFile, 'utf8')
    return yaml.load(text, { schema: entryListSchema })
  } finally {
    try { rmSync(outFile, { force: true }) } catch { /* temp cleanup is best-effort */ }
  }
}

/** Normalize rows: id → comparable options object. */
function normalize(rows) {
  const map = new Map()
  for (const row of rows) {
    map.set(row.id, JSON.stringify({
      name: row.name,
      disabled: row.disabled ?? null,
      group: row.group ?? null,
      inject: row.inject ?? null,
      config: row.config ?? null,
    }))
  }
  return map
}

let failures = 0
function fail(message) {
  failures += 1
  console.error(`  ✗ ${message}`)
}
function check(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else fail(message)
}

console.log(`validating profile "${profile}" (profileDir=${profileDir})`)
console.log(`launcher bin: ${bin}`)

// --- 1. the plugin's fresh recomposition -------------------------------
const freshPatches = await composeFresh(profileDir, home)
const freshRows = composeEntries([freshPatches])
const fresh = normalize(freshRows)
const freshOrder = freshRows.map(row => row.id)

// --- 2. the launcher's own dump -----------------------------------------
const dumpRows = runDump()
const dump = normalize(dumpRows)
const dumpOrder = dumpRows.map(row => row.id)

// --- 3. compare everything except the two boot-only overlays -------------
const EXCLUDED = new Set(['agent-presets', 'session-telemetry-otel'])
const freshIds = [...fresh].filter(([id]) => !EXCLUDED.has(id)).map(([id]) => id)
const dumpIds = [...dump].filter(([id]) => !EXCLUDED.has(id)).map(([id]) => id)

check(
  freshIds.length === dumpIds.length,
  `row count matches (fresh=${freshIds.length}, dump=${dumpIds.length})`,
)
const missing = freshIds.filter(id => !dump.has(id))
const extra = dumpIds.filter(id => !fresh.has(id))
check(missing.length === 0, `no fresh-only rows (${missing.length > 0 ? missing.join(', ') : ''})`)
check(extra.length === 0, `no dump-only rows (${extra.length > 0 ? extra.join(', ') : ''})`)

let diffed = 0
for (const id of freshIds) {
  if (dump.get(id) !== fresh.get(id)) {
    diffed += 1
    if (diffed <= 8) fail(`row "${id}" differs`)
  }
}
check(diffed === 0, `all shared rows identical (${diffed} differ)`)

const orderMatches = freshOrder.filter(id => !EXCLUDED.has(id)).join('|') === dumpOrder.filter(id => !EXCLUDED.has(id)).join('|')
check(orderMatches, 'row order matches')

// --- 4. boot-only overlays -----------------------------------------------
const freshAgent = freshRows.find(row => row.id === 'agent-presets')
check(freshAgent !== undefined, 'agent-presets row exists')
if (freshAgent !== undefined) {
  const roots = freshAgent.config?.roots
  const shipped = Array.isArray(roots)
    ? roots.find(r => r?.trust === 'system' && String(r.path).replaceAll('\\', '/').endsWith('config/agent-presets'))
    : undefined
  check(shipped !== undefined, `agent-presets carries the shipped system root (${shipped?.path ?? 'missing'})`)
  // The dump's agent-presets row + the same roots override must equal the fresh row.
  const dumpAgent = dumpRows.find(row => row.id === 'agent-presets')
  check(dumpAgent !== undefined, 'dump has agent-presets row')
  if (dumpAgent !== undefined) {
    const expect = JSON.stringify({
      name: dumpAgent.name,
      disabled: dumpAgent.disabled ?? null,
      group: dumpAgent.group ?? null,
      inject: dumpAgent.inject ?? null,
      config: { ...(dumpAgent.config ?? {}), roots },
    })
    check(expect === fresh.get('agent-presets'), 'agent-presets = dump row + shipped-roots overlay')
  }
}

// Telemetry switch: unset env ⇒ no patch ⇒ row unchanged.
const tele = freshRows.find(row => row.id === 'session-telemetry-otel')
const dumpTele = dumpRows.find(row => row.id === 'session-telemetry-otel')
if (tele !== undefined && dumpTele !== undefined) {
  check(fresh.get('session-telemetry-otel') === dump.get('session-telemetry-otel'), 'telemetry row unchanged when DSH_TELEMETRY_DISABLED unset')
} else {
  check(tele === undefined && dumpTele === undefined, 'no telemetry row on either side')
}

// Telemetry switch: env set ⇒ row disabled.
const previousDisabled = process.env.DSH_TELEMETRY_DISABLED
process.env.DSH_TELEMETRY_DISABLED = '1'
try {
  const disabledPatches = await composeFresh(profileDir, home)
  const disabledRows = composeEntries([disabledPatches])
  const teleDisabled = disabledRows.find(row => row.id === 'session-telemetry-otel')
  check(teleDisabled?.disabled === true || teleDisabled === undefined,
    `DSH_TELEMETRY_DISABLED=1 ⇒ telemetry row ${teleDisabled?.disabled === true ? 'disabled' : 'absent'}`)
} finally {
  if (previousDisabled === undefined) delete process.env.DSH_TELEMETRY_DISABLED
  else process.env.DSH_TELEMETRY_DISABLED = previousDisabled
}

console.log(failures === 0 ? '\nRESULT: PASS ✓' : `\nRESULT: ${failures} check(s) FAILED ✗`)
process.exit(failures === 0 ? 0 : 1)
