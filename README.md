# dsh-live-reload

**One-click hot reload of the running DSH plugin composition — without restarting the process.**

`dsh-live-reload` re-reads your profile's *full* plugin composition — every bundle layer
(`dsh.profile.bundles`), the profile user layer (`cordis.patch.yml`), the home user layer
(`$DSH_HOME/cordis.patch.yml`) and the launcher overlays (`--patch`, the agent-presets
shipped-roots overlay, the telemetry switch) — and applies it **live** to the running tree
through the root Include. The process, the web server and every open session stay up: the
loader mounts new rows, config-updates changed rows and disposes removed rows
transactionally, rolling back on failure. Only the rows that actually changed are touched.

> Today, installing a new plugin (e.g. via the plugin market) often ends with
> "restart DeepSeek Harness to apply". This plugin is the general fix for that: a button in
> Settings that hot-applies the whole composition, plus a page reload only when new *client*
> bundles appeared (the host process itself never exits).

## Features

- **One-click refresh** — a "Plugin Refresh / 插件刷新" section in Settings.
- **Full recomposition** — covers bundle layers (the part a normal boot freezes), user patch
  layers, `--patch` overlays, the agent-presets shipped-roots overlay and the
  `DSH_TELEMETRY_DISABLED` switch; verified byte-faithful against the launcher's own
  `dsh --profile <name> --dump-config` (see `scripts/validate-composition.mjs`).
- **Safe by construction** — reuses the exact transactional update path the built-in HMR
  uses on every `cordis.patch.yml` save; unchanged rows are never restarted, failures roll
  back, a refresh is serialized and bounded by a timeout.
- **Result report** — the button shows added / removed / updated rows and any activation
  errors, and offers a page reload only when new client bundles appeared.
- **No process exit** — the host keeps running; sessions replay their history from the
  persisted log after a page reload (the web app's standard reload recovery).

## Install

```bash
# from the repo checkout (development) or a published copy:
dsh plugin --profile web add github:<your-name>/dsh-live-reload

# or a local checkout (development iteration):
dsh plugin --profile web add link:/absolute/path/to/dsh-live-reload
```

The bundle layer activates on the next `dsh web` boot — **one restart is required only to
install the plugin itself**. From then on, plugin installs/removals/config edits can be
applied with the refresh button, no more restarts.

## Usage

1. Open the Web GUI → Settings → **Plugin Refresh / 插件刷新**.
2. Click **一键刷新插件 / Refresh Plugins**.
3. Read the result: `✓ 已热刷新` with added/removed/updated rows, or an error list.
4. If the result says new client plugins appeared, click **刷新页面 / Reload Page**
   (the host process stays up; only the browser reloads).

Power users can call the same endpoints directly:

```bash
curl -s http://127.0.0.1:3080/dsh-live-reload/status
curl -s -X POST -H 'origin: http://127.0.0.1:3080' http://127.0.0.1:3080/dsh-live-reload/refresh
```

## How it works

```
Settings button ──POST──▶ /dsh-live-reload/refresh
                            │
                            ▼
              composeFresh(profileDir)          # re-read bundle + user + overlay layers
                            │
                            ▼
        root Include entry.update({ config: { …includeConfig, patches } })
                            │        # the same transactional call the user-patch HMR makes
                            ▼
        loader reconciles: mount new rows · config-update changed rows · dispose removed rows
                            │
                            ▼
        audit (every enabled row has a live fiber) + diff report + client-graph change flag
```

The composition code (`composeFresh`) mirrors the launcher's `composeProfile`/`composeLive`
exactly, including the two boot-only overlays most reimplementations forget:

- the **agent-presets shipped-roots overlay** (without it a refresh would drop the
  installation's own preset root from the live roster), and
- the **telemetry switch** (`DSH_TELEMETRY_DISABLED`).

## Compatibility

- DSH profiles booted by the `dsh --profile` launcher (web, headless, custom). A hand-built
  tree without a profile directory is detected and reported.
- Requires `@deepseek-ai/dsh-app-boot` at runtime — it resolves through the profile's
  node_modules / `$DSH_HOME/profiles/node_modules` installation fallback (never declared as
  a dependency, same as the ecosystem market plugin).
- No `dsh.bundle`-level version pinning. **Verified on `0.1.0-rc.5`** (the harness
  that ships the fallback modules); other rc-era releases should behave the same
  way, but only rc.5 has actually been exercised.
- Windows / macOS / Linux — pure Node ESM host, zero native deps.

## Verification

`dsh-live-reload` was verified end-to-end on a real booted instance, isolated
from the working one (own `DSH_HOME`, OS-assigned port, `node_modules`
junctioned to the installation fallback):

- `GET /dsh-live-reload/status` → `200`, correct profile.
- `POST /dsh-live-reload/refresh` → `200 {ok: true}`, zero changes, repeated
  refreshes stable (no churn).
- Appending a new bundle to `dsh.profile.bundles` then refreshing →
  `added: ["<row>"]`, `errors: []` — the row mounts **live**, audit clean.
- Removing it then refreshing → `removed: ["<row>"]` — the row disposes live.
- `GET /plugins/dsh-live-reload/client.js` → `200`; the boot manifest
  (`window.__DSH_BOOT__`) carries the `dsh-live-reload` client entry.

The composition logic is additionally cross-checked against the launcher's own
`dsh --profile <name> --dump-config` output by
`node scripts/validate-composition.mjs <profile>` (row-identical, including the
agent-presets shipped-roots overlay and the telemetry switch).

The whole suite is scripted: `npm test` boots an isolated instance and runs
status / idempotent refresh / hot-mount / hot-unmount / client dispatch /
`clientGraphChanged` end-to-end, plus the boot-vs-fresh `agent-presets` audit
(see `scripts/e2e.mjs`).

## Known interactions

The built-in HMR watcher recomposes on every `cordis.patch.yml` save from the
bundle set **captured at boot**. If you install a new bundle and hot-apply it
with this plugin, a subsequent manual edit of `cordis.patch.yml` makes the
built-in watcher re-apply the *boot-time* bundle set (the new bundle's rows
drop out) — just click the refresh button again afterwards: it re-reads
everything fresh and re-applies the full composition.

## What still needs a restart

- **Updating an already-installed package to a new version** (the loader's module cache
  serves the old code for the same package name; module-level HMR is disabled on the web
  surface).
- Changing the web frontend shell itself or the `dsh` binary.
- The very first activation of this plugin (after install).

## Development

```bash
npm run build:client   # requires tsdown locally: pnpm add -D tsdown@^0.22.14 (or: npm i -D tsdown@^0.22.14)
npm run check          # node --check on both halves + shipped-artifact guards
npm test               # scripted e2e on an isolated instance (see scripts/e2e.mjs)
node scripts/validate-composition.mjs web   # compare recomposition vs launcher dump
```

The client bundle (`client/client.js`) is the shipped artifact — rebuild and commit it when
you change `src/client/index.js`. `tsdown` is intentionally **not** a declared
devDependency: `client/client.js` is committed, and a git/npm install of this package must
not drag in a build toolchain.

## Security

The refresh performs **no shell execution** and mutates only the in-memory loader tree.
The POST route is same-origin gated (matching the ecosystem market). A failed refresh rolls
back to the last good tree — it never leaves a half-applied composition.

## License

MIT
