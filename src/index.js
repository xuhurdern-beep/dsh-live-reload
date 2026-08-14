/**
 * dsh-live-reload — host half.
 *
 * Re-composes the FULL plugin composition of the running profile — bundle
 * layers (`dsh.profile.bundles`), the profile user layer (`cordis.patch.yml`),
 * the home user layer (`$DSH_HOME/cordis.patch.yml`) and the launcher
 * overlays (`--patch` files, the agent-presets shipped-roots overlay, the
 * telemetry switch) — and transactionally applies it to the live tree through
 * the root Include entry. The process, the web server and all sessions stay
 * up: only the loader rows that actually changed are mounted, updated or
 * disposed (unchanged rows are left untouched), exactly like the built-in
 * user-patch HMR that already hot-applies `cordis.patch.yml` edits.
 *
 * A refresh is a power action but performs no shell execution and mutates
 * only the in-memory loader tree (plus nothing on disk), so it is safe to
 * expose over a same-origin HTTP route.
 *
 * @module dsh-live-reload
 */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-live-reload'

const BIN = 'dsh-live-reload'

/** The root Include row id pinned by `mountRootInclude` (see dsh-app-boot). */
const INCLUDE_ID = 'include'

/** The telemetry row id targeted by the DSH_TELEMETRY_DISABLED switch. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** Upper bound for one refresh; a wedged loader update must fail, not hang. */
const REFRESH_TIMEOUT_MS = 120_000

/**
 * The Harness home — same rule as the launcher (`DSH_HOME` overrides ~/.dsh).
 * @returns {string} absolute home path.
 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * The booted profile directory, from the config tree's baseUrl. A hand-built
 * tree (no baseUrl) cannot be refreshed this way.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string} absolute profile directory.
 */
function profileDirOf(ctx) {
  if (ctx.baseUrl === undefined) {
    throw new Error(`${BIN}: no ctx.baseUrl — the composition was not booted from a profile`)
  }
  return fileURLToPath(new URL('.', ctx.baseUrl))
}

/**
 * `@deepseek-ai/dsh-app-boot` is shipped with the harness and resolves at
 * runtime through the profile's hoisted node_modules / installation fallback
 * (never declared as a dependency — the same runtime-import pattern the
 * ecosystem's market plugin uses for `cordis-plugin-include`).
 *
 * Anchors, in order: (1) the plugin package root's own parent walk (runtime:
 * the installed copy sits inside the profile's node_modules, so the walk
 * reaches the profile deps and the `$DSH_HOME/profiles/node_modules` flat
 * fallback); (2) the installation fallback directly (source-tree development
 * and offline validation).
 * @returns {Promise<typeof import('@deepseek-ai/dsh-app-boot') | null>}
 */
let appBootPromise
async function loadAppBoot() {
  if (appBootPromise !== undefined) return appBootPromise
  appBootPromise = (async () => {
    const anchors = [
      fileURLToPath(new URL('../', import.meta.url)),
      join(dshHome(), 'profiles', 'node_modules'),
    ]
    let lastAnchorError
    for (const base of anchors) {
      try {
        const require = createRequire(join(base, 'package.json'))
        const resolved = require.resolve('@deepseek-ai/dsh-app-boot')
        return await import(pathToFileURL(resolved).href)
      } catch (error) {
        // Keep the last failure for diagnostics; a bare specifier may simply
        // not resolve from every anchor.
        lastAnchorError = error
      }
    }
    console.warn(`${BIN}: cannot resolve @deepseek-ai/dsh-app-boot from ${anchors.join(' | ')}: ${lastAnchorError?.message}`)
    return null
  })()
  return appBootPromise
}

/** Resolve a `require` anchored at the profile's package.json. */
function requireFromProfile(profileDir) {
  return createRequire(join(profileDir, 'package.json'))
}

/**
 * Resolve one bundle package's directory from the profile anchor. Matches the
 * Loader's own resolution: the profile's node_modules first (pnpm-hoisted),
 * then the installation flat fallback `$DSH_HOME/profiles/node_modules`.
 * @param {NodeJS.Require} requireProfile
 * @param {string} packageName
 * @returns {string} absolute package directory.
 */
function resolveBundleDir(requireProfile, packageName) {
  try {
    return dirname(requireProfile.resolve(`${packageName}/package.json`))
  } catch (error) {
    throw new Error(
      `${BIN}: cannot resolve profile bundle ${JSON.stringify(packageName)} — `
      + `is it installed? Run 'dsh plugin --profile <name> add ${packageName}' (${error.message})`,
    )
  }
}

/** The installed dsh app package root, when resolvable (used for the shipped agent-presets root). */
function dshAppDir(requireProfile) {
  try {
    return dirname(requireProfile.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    return undefined
  }
}

/** `--patch <file>` / `--patch=<file>` overlays from this invocation's argv, in order. */
function patchFilesFromArgv() {
  const files = []
  const argv = process.argv
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--patch') {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        files.push(value)
        i += 1
      }
    } else if (token.startsWith('--patch=')) {
      files.push(token.slice('--patch='.length))
    }
  }
  return files
}

/**
 * Compose the FULL patch stack exactly as the launcher would boot it, read
 * fresh from disk: bundle layers in `dsh.profile.bundles` order, the profile
 * user layer, the home user layer, `--patch` overlays, the agent-presets
 * shipped-roots overlay and the telemetry switch.
 *
 * This is the faithful live mirror of `composeProfile`/`composeLive` in the
 * dsh launcher — a refresh must recompute everything, because bundle layers
 * (unlike the watched user patch files) are otherwise frozen at boot.
 *
 * The returned list is a fresh deep clone: the include pushes `insert` rows
 * into the mounted tree BY REFERENCE and later id-targeted patches mutate
 * those objects in place, so reusing one parsed patch object across
 * generations would bake a user override into a bundle's insert row.
 *
 * Pure function (no ctx): exported so tests and CLI tooling can compare the
 * recomposed stack against the launcher's own boot composition.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} [home] - Harness home (defaults to the launcher rule).
 * @returns {Promise<object[]>} the fresh patch stack.
 */
export async function composeFresh(profileDir, home = dshHome()) {
  const ab = await loadAppBoot()
  if (ab === null) {
    throw new Error(`${BIN}: @deepseek-ai/dsh-app-boot is not resolvable from the profile — cannot recompose`)
  }
  const requireProfile = requireFromProfile(profileDir)

  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundleNames = manifest.dsh?.profile?.bundles ?? []

  // 1. bundle layers — the part a boot freezes, read fresh here.
  const bundlePatches = []
  for (const packageName of bundleNames) {
    const packageDir = resolveBundleDir(requireProfile, packageName)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const declared = bundleManifest.dsh?.bundle?.patch
    if (typeof declared !== 'string') {
      throw new Error(`${BIN}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
    }
    bundlePatches.push(...ab.loadOverlayPatches(BIN, join(packageDir, declared)))
  }

  // 2. user layers — the files the built-in HMR already watches.
  const profilePatches = ab.loadOptionalPatches(BIN, join(profileDir, 'cordis.patch.yml')) ?? []
  const homePatches = ab.loadOptionalPatches(BIN, join(home, 'cordis.patch.yml')) ?? []

  // 3. launcher overlays.
  const overlays = []
  for (const file of patchFilesFromArgv()) {
    overlays.push(...ab.loadOverlayPatches(BIN, file))
  }

  // The composed row index BEFORE the launcher's own overlays, mirroring the
  // launcher's `rows` map (used to decide the agent-presets and telemetry
  // patches).
  const rows = new Map(
    ab.composeEntries([bundlePatches, profilePatches, homePatches, overlays]).map(row => [row.id, row]),
  )

  // 4. agent-presets shipped-roots overlay: without it a refresh would drop
  //    the installation's own preset root from the live roster. The path
  //    mirrors the launcher's SHIPPED_PRESET_ROOT exactly —
  //    `fileURLToPath(new URL('../config/agent-presets/', import.meta.url))`
  //    INCLUDING the trailing separator: a byte-identical row means the first
  //    refresh reports zero churn instead of a cosmetic one-time `updated`
  //    entry (observed before this fix as `updated: ["agent-presets"]`).
  if (rows.has('agent-presets')) {
    const appDir = dshAppDir(requireProfile)
    if (appDir !== undefined) {
      overlays.push({
        id: 'agent-presets',
        config: {
          ...(rows.get('agent-presets')?.config ?? {}),
          roots: [{ path: join(appDir, 'config', 'agent-presets') + sep, trust: 'system' }],
        },
      })
    }
  }

  // 5. telemetry switch (ANY non-empty value disables — same rule as boot).
  const disabledEnv = process.env.DSH_TELEMETRY_DISABLED
  if (disabledEnv !== undefined && disabledEnv !== '' && rows.has(TELEMETRY_ROW_ID)) {
    overlays.push({ id: TELEMETRY_ROW_ID, disabled: true })
  }

  return structuredClone([...bundlePatches, ...profilePatches, ...homePatches, ...overlays])
}

/**
 * Locate the root Include entry — the pinned `include` loader row the boot
 * include mounts the whole tree through.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function findRootInclude(ctx) {
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error(`${BIN}: loader service is unavailable`)
  for (const entry of loader.entries()) {
    if (entry.options.id === INCLUDE_ID || entry.options.name === 'cordis:include') return entry
  }
  return undefined
}

/**
 * Stable JSON stringify: object keys are sorted recursively, so two
 * semantically equal values with different key insertion order never diff.
 * (Loader entry configs are plain JSON from patches — no cycles, no functions.)
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Fingerprint of one loader row's effective options (scalar data only). */
function fingerprintEntry(entry) {
  const o = entry.options
  return JSON.stringify([
    o.name,
    o.disabled ?? null,
    o.inject ?? null,
    o.group ?? null,
    o.config === undefined || o.config === null ? null : stableStringify(o.config),
  ])
}

/**
 * Snapshot the current loader entry ids → fingerprints, for the refresh diff.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Map<string, string>}
 */
function snapshotEntries(ctx) {
  const loader = ctx.get('loader')
  const map = new Map()
  if (loader === undefined) return map
  for (const entry of loader.entries()) {
    if (entry.options.id === INCLUDE_ID) continue
    map.set(entry.options.id, fingerprintEntry(entry))
  }
  return map
}

/**
 * Diff two entry snapshots into added/removed/updated lists.
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 */
function diffEntries(before, after) {
  const added = []
  const removed = []
  const updated = []
  for (const [id, fp] of after) {
    if (!before.has(id)) added.push(id)
    else if (before.get(id) !== fp) updated.push(id)
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id)
  }
  return { added, removed, updated }
}

/**
 * Post-refresh audit, mirroring the boot's `assertEntriesActivated`: every
 * enabled loader row must have a live fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string[]} human-readable failures (empty when all rows are up).
 */
function auditEntries(ctx) {
  const loader = ctx.get('loader')
  if (loader === undefined) return [`${BIN}: loader service is unavailable`]
  const errors = []
  for (const entry of loader.entries()) {
    if (entry.disabled) continue
    if (entry.fiber === undefined) {
      errors.push(`${entry.options.id} (${entry.options.name ?? '?'}) did not activate`)
    }
  }
  return errors
}

/**
 * Fingerprint one installed bundle package on disk: every file's size and
 * mtime under the package dir (nested node_modules/.git skipped). Detects
 * in-place package updates (market reinstall/update rewrites the files) so a
 * refresh can load the new code instead of the loader's cached module.
 * @param {string} packageDir - absolute package directory.
 * @returns {string} deterministic fingerprint ('' for an unreadable dir).
 */
function fingerprintPackage(packageDir) {
  const parts = []
  const seen = new Set()
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (seen.has(full)) continue
      seen.add(full)
      if (entry.isDirectory()) { walk(full); continue }
      let st
      try { st = statSync(full) } catch { continue }
      parts.push(`${relative(packageDir, full).replaceAll('\\', '/')}:${st.size}:${Math.trunc(st.mtimeMs)}`)
    }
  }
  walk(packageDir)
  parts.sort()
  return parts.join('|')
}

/**
 * Rewrite the loader rows of every CHANGED package to a cache-busted entry
 * URL. The loader imports each row through Node's internal ESM ModuleLoader,
 * which caches module jobs keyed by the resolved URL — so an in-place package
 * update keeps serving the pre-update code (module-level HMR is disabled on
 * the web surface). Pointing the row at its own entry file with a `?dshr=<rev>`
 * query creates a NEW cache key per on-disk revision: the next import reads
 * the FRESH files. The name change also forces the loader's REPLACE path
 * (re-import → dispose the old fiber — withdrawing its tool registrations —
 * → start), which is exactly what an in-place reinstall needs and what the
 * reported "tool already registered" collision was missing.
 *
 * The busted URL is REMEMBERED per package (bustedNames): once a package has
 * been busted, every later refresh rewrites its rows to the same URL (stable
 * until the next on-disk change computes a new rev), so the row never flips
 * back to the plain package-name specifier and refreshes stay churn-free.
 *
 * Only rows whose `name` is the package name itself are rewritten (the
 * market-plugin pattern, e.g. `dsh-chat-import`, `@liustack/modlens`); the
 * plugin's own package is never busted (re-importing the code that is
 * executing the refresh mid-flight is not transactional).
 * @param {object[]} patches - the fresh patch stack (mutated in place).
 * @param {NodeJS.Require} requireProfile - profile-anchored resolver.
 * @param {string[]} changed - bundle package names whose files changed.
 * @param {Map<string, string>} packageHashes - name → current fingerprint.
 * @param {Map<string, string>} bustedNames - name → busted entry URL (persisted).
 * @param {string[]} currentBundles - package names in the profile manifest now.
 * @returns {string[]} the busted entry URLs applied to rows this pass.
 */
function bustChangedPackageRows(patches, requireProfile, changed, packageHashes, bustedNames, currentBundles) {
  // Changed packages get a fresh busted URL for their current on-disk revision.
  for (const name of changed) {
    if (name === BIN) continue
    let entryFile
    try { entryFile = requireProfile.resolve(name) } catch { continue }
    const rev = createHash('sha256').update(packageHashes.get(name) ?? name).digest('hex').slice(0, 12)
    bustedNames.set(name, `${pathToFileURL(entryFile).href}?dshr=${rev}`)
  }
  // Previously busted packages keep their remembered URL (stable, no churn);
  // packages that left the profile are pruned.
  const applied = []
  for (const [name, url] of bustedNames) {
    if (!currentBundles.includes(name)) { bustedNames.delete(name); continue }
    let hit = 0
    for (const patch of patches) {
      if (!Array.isArray(patch?.insert)) continue
      for (const row of patch.insert) {
        if (row?.name === name) { row.name = url; hit += 1 }
      }
    }
    if (hit > 0) applied.push(url)
  }
  return applied
}

/**
 * Record every bundle package's on-disk fingerprint and report the packages
 * that changed since the last snapshot. Seeded at boot-settle so a package
 * replaced AFTER boot (market reinstall) is detected on the very first
 * refresh. The plugin's own package is excluded (self-update is not
 * transactional).
 * @param {string} profileDir - absolute profile directory.
 * @param {Map<string, string>} packageHashes - state.packageHashes.
 * @param {boolean} seed - true to only record fingerprints (boot snapshot).
 * @returns {string[]} bundle package names whose files changed on disk.
 */
function syncPackageFingerprints(profileDir, packageHashes, seed) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const requireProfile = requireFromProfile(profileDir)
  const changed = []
  for (const name of bundles) {
    if (name === BIN) continue
    let dir
    try { dir = resolveBundleDir(requireProfile, name) } catch { continue }
    const fp = fingerprintPackage(dir)
    const previous = packageHashes.get(name)
    packageHashes.set(name, fp)
    if (!seed && previous !== undefined && previous !== fp) changed.push(name)
  }
  return changed
}

/**
 * Extract the offending package from a "tool ... is already registered" apply
 * failure, e.g. `... failed to apply loader entry import-claude (dsh-chat-import):
 * tool "import_claude" is already registered (...)` → `dsh-chat-import`.
 * @param {unknown} error
 * @returns {string | undefined} the package name, or undefined when the error
 * is not a tool-registration collision.
 */
function collisionPackage(error) {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/failed to apply loader entry \S+ \(([^)]+)\):\s*tool "[^"]+" is already registered/)
  return match?.[1]
}

/**
 * Force a new cache-busted entry URL for one package, even when its files did
 * NOT change on disk (a monotonic counter guarantees a fresh cache key). Used
 * by the collision self-heal: a re-applied row that collides with a still-live
 * registration gets a forced bust so the retry re-imports a fresh ModuleJob —
 * the loader's dispose-before-start order then withdraws the old registration.
 * @param {NodeJS.Require} requireProfile - profile-anchored resolver.
 * @param {string} packageName
 * @param {{bustCounter: number}} state
 * @returns {string | undefined} the busted entry URL, or undefined when the
 * package entry cannot be resolved.
 */
function forceBustUrl(requireProfile, packageName, state) {
  let entryFile
  try { entryFile = requireProfile.resolve(packageName) } catch { return undefined }
  state.bustCounter += 1
  const rev = createHash('sha256').update(`${packageName}:${state.bustCounter}:${Date.now()}`).digest('hex').slice(0, 12)
  return `${pathToFileURL(entryFile).href}?dshr=${rev}`
}

/**
 * Perform one restart-free composition refresh.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{refreshing: boolean, last: object | null, packageHashes: Map<string, string>}} state
 * @returns {Promise<object>} JSON-safe result for the route and status page.
 */
async function performRefresh(ctx, state) {
  const profileDir = profileDirOf(ctx)
  const patches = await composeFresh(profileDir)

  const include = findRootInclude(ctx)
  if (include === undefined) {
    throw new Error(`${BIN}: root Include entry not found — cannot live-apply the composition`)
  }

  // In-place bundle updates: any package whose files changed on disk since
  // boot/the last refresh gets its loader rows re-pointed at a cache-busted
  // entry URL, so the reconcile below re-imports and runs the NEW code. The
  // loader's replace path disposes the old fiber (withdrawing its tool
  // registrations) BEFORE starting the new one — no "already registered"
  // collision, no restart.
  const changed = syncPackageFingerprints(profileDir, state.packageHashes, false)
  const requireProfile = requireFromProfile(profileDir)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const currentBundles = manifest.dsh?.profile?.bundles ?? []
  const busted = bustChangedPackageRows(patches, requireProfile, changed, state.packageHashes, state.bustedNames, currentBundles)

  const before = snapshotEntries(ctx)
  const clientModules = ctx.get('clientModules')
  const revBefore = clientModules?.graph()?.rev

  // The exact transactional call the built-in user-patch HMR makes on every
  // cordis.patch.yml save: swap the include's patch stack and let the loader
  // reconcile the tree (mount new rows, config-update changed rows, dispose
  // removed rows, roll back on failure).
  const applyComposition = async () => {
    const { patches: _previous, ...includeConfig } = include.options.config ?? {}
    await include.update({ config: { ...includeConfig, patches } })
  }

  let selfHealed = []
  try {
    await applyComposition()
  } catch (error) {
    // Collision self-heal: a re-applied row that registers a tool name still
    // held by its previous fiber fails with "already registered". Force-bust
    // the offending package (a fresh cache key even when its files did not
    // change), rewrite its rows in the patch stack, and retry ONCE — the
    // replace path then disposes the old fiber (withdrawing the registration)
    // before the fresh apply runs. Genuine conflicts with other packages are
    // NOT masked: the retry re-fails and the original error is rethrown.
    const pkg = collisionPackage(error)
    if (pkg !== undefined && pkg !== BIN) {
      const url = forceBustUrl(requireProfile, pkg, state)
      if (url !== undefined) {
        state.bustedNames.set(pkg, url)
        for (const patch of patches) {
          if (!Array.isArray(patch?.insert)) continue
          for (const row of patch.insert) {
            if (row?.name === pkg) row.name = url
          }
        }
        try {
          await applyComposition()
          selfHealed = [pkg]
          busted.push(url)
        } catch {
          // The retry failed too — a genuine conflict; surface the original error.
          throw error
        }
      } else {
        throw error
      }
    } else {
      throw error
    }
  }

  // Let the loader flush remaining lifecycle tasks and the client-modules
  // graph settle, then audit + diff.
  await ctx.get('loader')?.await()
  await new Promise((resolve) => { const t = setTimeout(resolve, 0); t.unref?.() })

  const after = snapshotEntries(ctx)
  const revAfter = clientModules?.graph()?.rev
  const errors = auditEntries(ctx)

  return {
    ok: errors.length === 0,
    profile: basename(profileDir),
    ...diffEntries(before, after),
    errors,
    clientGraphChanged: revBefore !== undefined && revAfter !== undefined && revBefore !== revAfter,
    // Packages whose files changed on disk since the last snapshot; their rows
    // were cache-busted and re-applied with the fresh code (bustedRowUrls).
    ...(changed.length > 0 ? { updatedOnDisk: changed, bustedRowUrls: busted } : {}),
    // A "tool already registered" collision was healed by a forced cache-bust
    // + a single retry (the offending package's rows were re-applied fresh).
    ...(selfHealed.length > 0 ? { selfHealed } : {}),
  }
}

/** Same-origin gate for the POST routes (same rule as the ecosystem market). */
function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** JSON helper for route responses. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Bound a promise so a wedged refresh cannot hang the HTTP route. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${BIN}: ${label} timed out after ${ms}ms`)), ms)
      t.unref?.()
    }),
  ])
}

/**
 * Register the status/refresh routes on the web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{refreshing: boolean, last: object | null}} state
 * @returns {(() => void) | undefined} route disposer (or undefined without a web server).
 */
function registerRoutes(ctx, state) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: '/dsh-live-reload/status',
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405)
          response.end()
          return
        }
        let profile = '?'
        try {
          profile = basename(profileDirOf(ctx))
        } catch {
          // hand-built tree without a profile directory — still answer
        }
        sendJson(response, 200, {
          plugin: 'dsh-live-reload',
          profile,
          refreshing: state.refreshing,
          last: state.last,
        })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh-live-reload/refresh',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405)
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        if (state.refreshing) {
          sendJson(response, 409, { ok: false, error: 'a refresh is already running' })
          return
        }
        state.refreshing = true
        try {
          const result = await withTimeout(performRefresh(ctx, state), REFRESH_TIMEOUT_MS, 'refresh')
          state.last = {
            at: Date.now(),
            ok: result.ok,
            added: result.added,
            removed: result.removed,
            updated: result.updated,
            errors: result.errors,
          }
          sendJson(response, result.ok ? 200 : 502, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          state.last = { at: Date.now(), ok: false, errors: [message], added: [], removed: [], updated: [] }
          sendJson(response, 502, {
            ok: false,
            error: message,
            added: [],
            removed: [],
            updated: [],
            errors: [message],
            clientGraphChanged: false,
          })
        } finally {
          state.refreshing = false
        }
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Cordis plugin entry.
 *
 * Route registration is late-bound: `webServer` is a root row that may still
 * be mounting when this row activates, and on headless/custom profiles it may
 * never exist at all (the plugin then stays inert instead of failing the boot
 * as a pending inject). We retry once the loader tree settles and whenever a
 * new loader entry comes up — the realistic window covers boot ordering.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const state = { refreshing: false, last: null, packageHashes: new Map(), bustedNames: new Map(), bustCounter: 0 }
  const disposers = []

  const tryRegister = () => {
    if (disposers.length > 0) return true
    const dispose = registerRoutes(ctx, state)
    if (dispose === undefined) return false
    disposers.push(dispose)
    return true
  }

  // (1) Retry whenever a loader entry's fiber comes up (webServer included).
  let unsubPlugin = () => {}
  const onPlugin = () => {
    if (tryRegister()) unsubPlugin()
  }
  unsubPlugin = ctx.on('internal/plugin', onPlugin)

  // (2) Also re-check once the whole tree has settled (covers non-entry
  //     providers and guarantees webServer is up if it ever will be), and
  //     record the boot-time package fingerprints so the first refresh can
  //     spot bundles replaced on disk after boot.
  void Promise.resolve().then(async () => {
    try {
      await ctx.get('loader')?.await()
    } catch {
      // the tree settled into failure; the internal/plugin path keeps trying
    }
    try {
      syncPackageFingerprints(profileDirOf(ctx), state.packageHashes, true)
    } catch {
      // hand-built tree without a profile — cache busting stays off
    }
    if (tryRegister()) unsubPlugin()
  })

  ctx.effect(() => () => {
    unsubPlugin()
    for (const dispose of disposers) dispose()
  }, 'dsh-live-reload: routes lifecycle')
}
