# Issue draft — upstream deepseek-harness

> Prepared from a real reproduction via the `dsh-live-reload` plugin (third-party,
> https://github.com/xuhurdern-beep/dsh-live-reload). Filed for upstream discussion.

---

## Title

**Hot re-apply of an in-place updated plugin package fails with `tool "X" is already registered`; the loader's module cache also serves the pre-update code**

## Summary

When a plugin package that is **already mounted** in the running tree is updated **in place** on
disk (the plugin market reinstalls/updates it: files under `node_modules/<pkg>` are rewritten),
re-applying the composition through the root Include fails:

```
failed to apply loader entry include (cordis:include): failed to apply loader entry
import-claude (dsh-chat-import): tool "import_claude" is already registered
(for a per-agent variant, register through that agent's `agent.ctx` instead)
```

A fresh boot with the same composition works fine (the row is the first registrant). The failure
only happens when the row is re-applied while its previous fiber is still live.

## Environment

- deepseek-harness `0.1.0-rc.5`
- Node v24.13.0, Windows
- Profile: web (bundle list includes `dsh-base`, `dsh-web-app`, a tool-registering plugin)

## Reproduction

1. Boot a profile whose bundles include a plugin that registers a tool (e.g. any `ctx.tools.register` plugin).
2. While the instance is running, **reinstall/update that same plugin** (market action rewrites
   `node_modules/<pkg>`; the profile manifest / bundle layer is touched).
3. Hot-apply the composition (built-in user-patch HMR on `cordis.patch.yml`, or the
   `dsh-live-reload` refresh which calls the same `include.update`).
4. Observe: the row is re-applied; `apply()` re-runs `ctx.tools.register({ name: '...' })`;
   the name is still owned by the previous fiber → `already registered` → the whole include
   update rolls back (transactional) → the refresh reports failure.

Even when the row's options are otherwise identical (so no collision), the loader's ESM module
cache serves the **old** code for the same package URL — the updated package's new code never
loads without a process restart.

## Root-cause analysis

- **Module cache**: the loader imports every row through Node's internal ESM `ModuleLoader`
  (`cordis-plugin-loader` `src/internal.ts`: `ctx.loader.internal.loadCache`, keyed by file URL).
  An in-place package update keeps the same URLs, so `loadCache` returns the pre-update
  `ModuleJob`. Module-level HMR is intentionally off on the web surface, but there is **no
  documented/supported API to evict a package's cached jobs**, so third-party hot-reload tooling
  must either restart the process or reach into `loader.internal.loadCache` (Node internals).
- **Duplicate registration on re-apply**: the entry replace path (`src/config/entry.ts`) is
  `import(candidate.name)` → `dispose(previous)` → `start(plugin)`. If the import hits the stale
  cache, the "new" apply runs the OLD code while the old fiber may still hold its registrations —
  the observed `already registered` error. (The harness's own HMR handles withdrawal for
  `tool-fs`'s `read_image`; the re-apply ordering above is the fragile spot for out-of-tree
  plugins.)

## Expected behavior

1. A documented, supported way to evict/reload the cached module jobs of one package
   (e.g. a `loader.evictPackage(pkgDir)` or a cache-busting import path), so in-place package
   updates can be hot-applied without a restart; **and**
2. the re-apply path must withdraw the previous fiber's tool registrations **before** the new
   `apply()` runs, so a re-applied row can never collide with its own previous generation; or,
   failing that, produce an actionable error ("package X was updated on disk; a restart is
   required to load the new code") instead of the cryptic tool-name collision.

## Workaround demonstrated today

`dsh-live-reload` (v0.2.0) detects on-disk package changes (a per-bundle file
fingerprint seeded at boot) and re-points the changed package's loader rows at
a **cache-busted entry URL** (`<entry file URL>?dshr=<rev>`), which creates a
fresh module-cache key per on-disk revision and forces the loader's replace
path (re-import → dispose the old fiber — withdrawing its tool registrations →
start). Verified in its scripted e2e: after an in-place rewrite of a mounted
bundle, a refresh re-imports and runs the **new** code (marker file v1→v2) with
the same tool name, no collision, no restart. It relies on Node's URL-keyed ESM
cache semantics; a first-class loader API (documented eviction or reload of one
package) would make it robust and remove the need for the query-string trick.
