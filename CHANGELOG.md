# Changelog

All notable changes to dsh-live-reload are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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

### Changed

- Version bumped to 0.2.0. README "What still needs a restart" narrowed: only a
  changed package whose loader row is otherwise identical still needs a restart
  (nothing to re-apply; reported via `updatedOnDisk`).

### Fixed

- In-place updates no longer fail with "tool already registered": the busted
  row name forces the loader's replace path, whose dispose-before-start order
  withdraws the old fiber's registrations before the new apply runs.

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
