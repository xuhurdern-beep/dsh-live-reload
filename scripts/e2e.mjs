#!/usr/bin/env node
/**
 * Scripted end-to-end verification of dsh-live-reload on an isolated REAL
 * instance: boots a throwaway `web-e2e-<pid>` profile under the user's DSH
 * home (sharing the same installation fallback as the working instance, via
 * the same link:/junction layout `dsh plugin add link:` produces), then runs
 * the whole suite through the plugin's HTTP routes.
 *
 * Covers: status / idempotent refresh / hot-mount / hot-unmount / client
 * dispatch / boot manifest / clientGraphChanged=true path / the P0-2 audit
 * (does the first refresh still touch `agent-presets`? does the boot-time
 * loader row match a fresh recomposition?).
 *
 * Usage: node scripts/e2e.mjs
 * Exit code: 0 = every check passed; non-zero otherwise.
 *
 * Requirements: a DSH harness installed under the user home (the launcher
 * resolves through `$DSH_HOME/profiles/node_modules`, same as the plugin at
 * runtime), and the repo's own checkout (the profile links into it).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const BIN_NAME = 'dsh-live-reload'
const profileName = `web-e2e-${process.pid}`
const profileDir = join(realHome, 'profiles', profileName)
const bootLog = join(profileDir, 'boot.log')
const probeOut = join(profileDir, 'probe-agent-presets.json')

let failures = 0
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
function check(condition, label, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

/** The dsh launcher bin, resolved through the installation fallback. */
function resolveLauncher() {
  const fr = createRequire(join(realHome, 'profiles', 'node_modules', 'anchor.js'))
  const appDir = dirname(fr.resolve('@deepseek-ai/dsh/package.json'))
  return existsSync(join(appDir, 'lib', 'bin.js')) ? join(appDir, 'lib', 'bin.js') : join(appDir, 'src', 'bin.ts')
}

/** Stable JSON stringify (sorted keys) — mirrors the plugin's diff fingerprint. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function refresh(base) {
  const res = await fetch(`${base}/dsh-live-reload/refresh`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: '{}',
  })
  return { status: res.status, body: await res.json() }
}

async function status(base) {
  const res = await fetch(`${base}/dsh-live-reload/status`)
  return { status: res.status, body: await res.json() }
}

function setBundles(bundles) {
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  pkg.dsh.profile.bundles = bundles
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

/** Remove junctions first (unlink removes the reparse point, not the target), then the profile dir. */
function cleanup(child) {
  try { child?.kill() } catch { /* already gone */ }
  const junctions = ['dsh-live-reload', 'e2e-bundle', 'e2e-client-bundle']
  for (const name of junctions) {
    try { unlinkSync(join(profileDir, 'node_modules', name)) } catch { /* absent */ }
  }
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort */ }
}

async function main() {
  console.log(`dsh-live-reload e2e — profile "${profileName}" under ${realHome}`)
  console.log(`launcher bin: ${resolveLauncher()}`)
  console.log('='.repeat(72))

  // --- 0. isolated profile scaffolding -------------------------------
  try {
    rmSync(profileDir, { recursive: true, force: true })
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    type: 'module',
    dependencies: {
      'dsh-live-reload': `link:${REPO.replaceAll('\\', '/')}`,
      'e2e-bundle': `link:${join(REPO, 'e2e', 'bundles', 'e2e-bundle').replaceAll('\\', '/')}`,
      'e2e-client-bundle': `link:${join(REPO, 'e2e', 'bundles', 'e2e-client-bundle').replaceAll('\\', '/')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-live-reload'] } },
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# e2e: bind an OS-assigned port so this instance cannot collide with the working one',
    '- id: webserver',
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '',
    '# e2e: capture the boot-time agent-presets loader row for the P0-2 audit',
    '- insert:',
    '    - id: e2e-probe',
    "      name: './e2e-probe.js'",
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(profileDir, 'e2e-probe.js'), [
    "// e2e probe — dumps the boot-time agent-presets loader row for the P0-2 audit.",
    "import { writeFileSync } from 'node:fs'",
    "export const name = 'e2e-probe'",
    'export function apply(ctx) {',
    '  const out = process.env.DSH_E2E_PROBE_OUT',
    '  const dump = (entry) => writeFileSync(out, JSON.stringify({ at: "boot", entry }, null, 2))',
    '  setTimeout(async () => {',
    '    try {',
    '      const loader = ctx.get("loader")',
    '      const deadline = Date.now() + 10_000',
    '      let entry',
    '      while (Date.now() < deadline) {',
    '        entry = [...(loader?.entries?.() ?? [])].find(e => e.options.id === "agent-presets")',
    '        if (entry !== undefined) break',
    '        await new Promise(r => setTimeout(r, 200))',
    '      }',
    '      dump(entry?.options ?? null)',
    '    } catch (error) {',
    '      writeFileSync(out, JSON.stringify({ at: "boot", error: String(error) }, null, 2))',
    '    }',
    '  }, 500)',
    '}',
    '',
  ].join('\n'), 'utf8')

  // profile node_modules: the same link:/junction layout `dsh plugin add link:` produces.
  for (const name of ['dsh-live-reload', 'e2e-bundle', 'e2e-client-bundle']) {
    const target = name === 'dsh-live-reload'
      ? REPO
      : join(REPO, 'e2e', 'bundles', name)
    symlinkSync(target, join(profileDir, 'node_modules', name), 'junction')
  }
  check(true, 'profile scaffold + link:/junction layout created')
  } catch (scaffoldError) {
    cleanup(undefined)
    throw scaffoldError
  }

  // --- 1. boot the isolated instance ----------------------------------
  let child
  try {
    const fd = openSync(bootLog, 'w')
    child = spawn(process.execPath, [resolveLauncher(), '--profile', profileName], {
      cwd: realHome,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_E2E_PROBE_OUT: probeOut },
      stdio: ['ignore', fd, 'inherit'],
    })

    let url
    const bootDeadline = Date.now() + 120_000
    while (Date.now() < bootDeadline && child.exitCode === null) {
      try {
        const text = readFileSync(bootLog, 'utf8')
        const match = text.match(/dsh web: (https?:\/\/\S+)/)
        if (match) { url = match[1]; break }
      } catch { /* log not flushed yet */ }
      await sleep(700)
    }
    if (url === undefined) {
      const tail = existsSync(bootLog) ? readFileSync(bootLog, 'utf8').split(/\r?\n/).slice(-25).join('\n') : '(no log)'
      check(false, `instance booted (URL found)`, `no 'dsh web:' line; log tail:\n${tail}`)
      return
    }
    check(true, `instance booted — ${url}`)

    // wait for the plugin routes (late-bound until webServer is up)
    let ready = false
    for (let i = 0; i < 30; i += 1) {
      try {
        const st = await status(url)
        if (st.status === 200) { ready = true; break }
      } catch { /* server still settling */ }
      await sleep(500)
    }
    check(ready, 'GET /dsh-live-reload/status → 200')

    // --- 2. P0-2 audit: first refresh must not touch agent-presets ---------
    const first = await refresh(url)
    check(first.status === 200 && first.body.ok === true, 'refresh #1 → ok:true', JSON.stringify(first.body))
    check(first.body.updated?.length === 0, 'refresh #1 → updated: [] (no agent-presets churn)', `updated=${JSON.stringify(first.body.updated ?? [])}`)

    // boot-time loader row vs a fresh recomposition
    let probe
    for (let i = 0; i < 20 && !existsSync(probeOut); i += 1) await sleep(250)
    try {
      probe = JSON.parse(readFileSync(probeOut, 'utf8'))
    } catch { /* probe may not have flushed; reported below */ }
    const fr = createRequire(join(realHome, 'profiles', 'node_modules', 'anchor.js'))
    const { composeEntries } = await import(pathToFileURL(fr.resolve('@deepseek-ai/dsh-app-boot')).href)
    const { composeFresh } = await import(pathToFileURL(join(REPO, 'src', 'index.js')).href)
    const freshRows = composeEntries([await composeFresh(profileDir, realHome)])
    const freshAgent = freshRows.find(row => row.id === 'agent-presets')
    if (probe?.entry === undefined) {
      check(false, 'boot-time agent-presets row captured', probe?.error ? `probe error: ${probe.error}` : 'probe file missing')
    } else {
      const same = stableStringify(probe.entry) === stableStringify(freshAgent)
      check(same, 'boot-time agent-presets row === fresh recomposition (no runtime writer)', same ? '' : `boot=${JSON.stringify(probe.entry)} fresh=${JSON.stringify(freshAgent)}`)
    }

    // --- 3. idempotence -----------------------------------------------------
    const second = await refresh(url)
    check(second.status === 200 && second.body.ok === true && second.body.added?.length === 0
      && second.body.removed?.length === 0 && second.body.updated?.length === 0,
      'refresh #2 → zero changes (idempotent, no churn)', JSON.stringify(second.body))

    // --- 4. hot-mount / hot-unmount of a host-only bundle -------------------
    setBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-live-reload', 'e2e-bundle'])
    const mounted = await refresh(url)
    check(mounted.status === 200 && mounted.body.ok === true && (mounted.body.added ?? []).includes('e2e-probe-row'),
      'append bundle → row hot-mounts live', JSON.stringify(mounted.body))
    setBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-live-reload'])
    const unmounted = await refresh(url)
    check(unmounted.status === 200 && unmounted.body.ok === true && (unmounted.body.removed ?? []).includes('e2e-probe-row'),
      'remove bundle → row hot-disposes live', JSON.stringify(unmounted.body))

    // --- 5. clientGraphChanged=true path (new client half appears) ----------
    setBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-live-reload', 'e2e-client-bundle'])
    const clientMounted = await refresh(url)
    check(clientMounted.status === 200 && clientMounted.body.ok === true && (clientMounted.body.added ?? []).includes('e2e-client-row'),
      'append client bundle → row hot-mounts', JSON.stringify(clientMounted.body))
    check(clientMounted.body.clientGraphChanged === true,
      'clientGraphChanged === true when a new client bundle appears', `rev changed → ${clientMounted.body.clientGraphChanged}`)
    try {
      const clientRes = await fetch(`${url}/plugins/e2e-client-bundle/client.js`)
      check(clientRes.status === 200, 'GET /plugins/e2e-client-bundle/client.js → 200', `status ${clientRes.status}`)
    } catch (error) {
      check(false, 'GET /plugins/e2e-client-bundle/client.js → 200', String(error))
    }
    setBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-live-reload'])
    const clientUnmounted = await refresh(url)
    check(clientUnmounted.status === 200 && clientUnmounted.body.ok === true && (clientUnmounted.body.removed ?? []).includes('e2e-client-row'),
      'remove client bundle → row hot-disposes', JSON.stringify(clientUnmounted.body))

    // --- 6. own client dispatch + boot manifest -----------------------------
    try {
      const ownClient = await fetch(`${url}/plugins/dsh-live-reload/client.js`)
      check(ownClient.status === 200, 'GET /plugins/dsh-live-reload/client.js → 200', `status ${ownClient.status}`)
    } catch (error) {
      check(false, 'GET /plugins/dsh-live-reload/client.js → 200', String(error))
    }
    try {
      const index = await (await fetch(url)).text()
      const boot = index.match(/__DSH_BOOT__\s*=\s*(\{.*?\})\s*<\/script>/s)?.[1]
      check(boot !== undefined && boot.includes('dsh-live-reload'), 'boot manifest carries the dsh-live-reload client entry')
    } catch (error) {
      check(false, 'boot manifest carries the dsh-live-reload client entry', String(error))
    }
  } finally {
    // --- 7. teardown ---------------------------------------------------------
    if (child !== undefined && child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill()
      })
    }
    cleanup(child)
    console.log(`  ✓ isolated profile removed (${profileName})`)
  }

  console.log('='.repeat(72))
  console.log(failures === 0 ? 'E2E: PASS ✓' : `E2E: ${failures} check(s) FAILED ✗`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
