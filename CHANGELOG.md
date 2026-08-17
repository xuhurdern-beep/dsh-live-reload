# Changelog

All notable changes to dsh-live-reload are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Market hot-mount collision on refresh**: when a plugin was hot-installed
  by the market (`mkt-*` rows in the market's runtime-only subtree) and the
  bundle layer later owns the same package, a refresh re-applying the
  bundle-layer row failed with `tool "..." is already registered` — the
  hot-mount fiber kept its global tool registrations, and the self-heal's
  force-bust could not retire it. The refresh now disposes the live `mkt-*`
  rows for the colliding package (withdrawing the registrations) and retries
  once, so `一键刷新插件` heals the hot-install residue instead of erroring.
- **`collisionPackage` with cache-busted row names**: the collision
  self-heal now extracts the package name from a `node_modules/<pkg>/`
  segment when the failing row's name is a cache-busted entry URL
  (`file:///.../index.mjs?dshr=<rev>`), instead of passing the whole URL to
  `require.resolve` and rethrowing.
- **Real theme tokens**: the client settings card now consumes the harness's
  actual `--dsw-alias-*` design tokens (verified against the client Theme
  service registry in `@deepseek-ai/dsh-client-ui-theme`) instead of the
  previously guessed `--dsh-color-*` names — the section now follows the
  active theme / color scheme instead of relying on neutral fallbacks. The
  primary-button pair matches the harness's own `Button.module.css`
  (`--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`).
- **Diff fingerprint key-order sensitivity**: the refresh diff now
  stable-stringifies row configs (recursively sorted keys), so two
  semantically identical configs with different key insertion order no longer
  report a spurious one-time `updated` entry (this also explains the
  previously observed one-time `updated: ["agent-presets"]` on the very first
  refresh after boot — see the e2e P0-2 audit in `scripts/e2e.mjs`).

### Changed

- **Module-cache eviction for upgraded packages**: the `?dshr=` bust previously
  only re-keyed a row's ENTRY file — the entry's RELATIVE imports resolve
  without the query, so an upgrade that changed non-entry files (e.g.
  dshmarket's `lib/dsh-cli.js` gaining an export its new `index.js` imports)
  kept serving the pre-update modules and failed with
  `The requested module './dsh-cli.js' does not provide an export named ...`.
  The refresh now evicts every busted package's modules from the Node internal
  ESM `loadCache` (all file URLs under the package plus the busted entry URL)
  before applying, so changed relative dependencies load fresh too. Falls back
  to the entry-only bust when the Node internals are unavailable.
- **Error chain surfaced on failure**: a wrapped failure like
  `failed to rollback loader entry include (cordis:include): ` (the inner
  `AggregateError` message is empty by default) previously hid the underlying
  cause. The refresh response and the settings section now flatten the whole
  cause chain (incl. `AggregateError.errors`), so the real reason (e.g.
  `tool "X" is already registered` or `webserver: duplicate prefix route ...`)
  is always visible.
- **Direct refresh: success always reloads the page** — `一键刷新插件` no longer
  diffs for client-graph changes (`clientGraphChanged`) to decide whether a
  page reload is needed. A successful refresh now always reloads the page
  after a brief pause (host process and all sessions stay up). This makes a
  market hot-install land in the running browser every time: the reload
  re-fetches the live boot manifest, which already carries the new package's
  client bundle. (The old signal was blind for market hot-mounts anyway —
  the client graph is deduplicated by package name, and the hot-mount row
  already registered the package before the refresh ran.) Failures never
  reload — the error panel stays readable.
- `devDependencies` (`tsdown`) removed from `package.json`: `client/client.js`
  is a committed build artifact, and installing this package (git or npm) must
  not drag in a build toolchain. Local rebuilds need
  `pnpm add -D tsdown@^0.22.14` (see README "Development").
- Publishing metadata added (`repository`, `homepage`, `bugs`, `author`,
  `engines`). **Before publishing to npm, point `repository`/`homepage`/`bugs`
  at the actual hosted repo.**
- Compatibility wording narrowed: the plugin is verified on DSH
  `0.1.0-rc.5` (the harness that ships the fallback modules); other rc-era
  releases are expected to behave the same but are not individually tested.
- The settings section now shows an inline hint about the built-in HMR
  watcher interaction (manual `cordis.patch.yml` saves replay the boot-time
  bundle set).

### Added

- `scripts/check-artifacts.mjs` — guards on the shipped client artifact
  (sourcemap must not leak absolute local paths; bundle must reference real
  theme tokens and no guessed ones); wired into `npm run check`.
- `scripts/e2e.mjs` — scripted end-to-end suite on an isolated real instance
  (status / idempotent refresh / hot-mount / hot-unmount / client dispatch /
  boot manifest / `clientGraphChanged=true` path / the P0-2 boot-vs-fresh
  agent-presets audit); wired into `npm test`.
- e2e fixture bundles under `e2e/bundles/` (`e2e-bundle`, `e2e-client-bundle`).

## [0.2.0] - 2026-08-15

### Added

- **Hot package updates**: the refresh fingerprints every bundle package on disk
  (seeded at boot-settle). When a mounted package's files change in place
  (market reinstall/update), its loader rows are re-pointed at a cache-busted
  entry URL (`<entry>?dshr=<rev>`), so the loader re-imports and runs the NEW
  code through its replace path — which disposes the old fiber (withdrawing its
  tool registrations) before starting the new one, eliminating the reported
  `tool "X" is already registered` collision and the restart requirement for
  in-place package updates. The result reports `updatedOnDisk` and
  `bustedRowUrls`. The plugin's own package is excluded (self-update is not
  transactional).
- The client result panel shows the hot-loaded `updatedOnDisk` packages.
- **Collision self-heal**: when an include update fails with
  `tool "X" is already registered` (a re-applied row colliding with a
  still-live registration even though its files did not change), the refresh
  identifies the offending package from the error, force-busts its module
  cache (a fresh cache key via a monotonic counter), and retries the
  composition ONCE — the replace path disposes the old fiber (withdrawing the
  registration) before the fresh apply. Reported via `selfHealed`. Genuine
  conflicts with other packages are not masked (the retry re-fails and the
  original error is surfaced).

### Changed

- Version bumped to 0.2.0. README "What still needs a restart" narrowed: only a
  changed package whose loader row is otherwise identical still needs a restart
  (nothing to re-apply; reported via `updatedOnDisk`).

### Fixed

- In-place updates no longer fail with "tool already registered": the busted
  row name forces the loader's replace path, whose dispose-before-start order
  withdraws the old fiber's registrations before the new apply runs.
- The busted row name is remembered per package: without persistence the next
  refresh would flip the row back to the plain package-name specifier —
  re-importing the boot-time module (reverting a real reinstall's new code)
  and churning `updated` on every refresh. Busted rows now stay stable until
  the next on-disk change computes a new rev.

## [0.1.0] - 2026-08-15

Initial release: one-click restart-free refresh of the running DSH plugin
composition — re-applies bundle layers, user patch layers, `--patch`
overlays, the agent-presets shipped-roots overlay and the telemetry switch
through the root Include, with transactional rollback, a post-refresh audit,
a row-level diff report and a page-reload hint when new client bundles
appeared.

Verified end-to-end on an isolated real instance (own DSH_HOME, OS-assigned
port, node_modules junctioned to the installation fallback) and cross-checked
against the launcher's own `dsh --profile <name> --dump-config` composition.
