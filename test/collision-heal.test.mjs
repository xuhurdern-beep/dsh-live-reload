/**
 * Unit coverage for the market hot-mount collision self-heal
 * (`collisionPackage` + `disposeMarketHotMounts`).
 *
 * Reproduces the real failure this fixes:
 *   `failed to apply loader entry include (cordis:include): failed to apply
 *   loader entry import-claude (file:///.../node_modules/dsh-chat-import/
 *   index.mjs?dshr=...): tool "import_claude" is already registered (...)` —
 *   the failing row's name is a cache-busted entry URL, and the conflicting
 *   registration is held by the market's still-mounted `mkt-*` row.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collisionPackage, disposeMarketHotMounts } from '../src/index.js'

// The exact error shape observed on a real profile after a market hot-install
// of dsh-chat-import followed by a refresh.
const REAL_ERROR = new Error(
  'failed to apply loader entry include (cordis:include): failed to apply loader entry import-claude '
  + '(file:///C:/Users/x2716/.dsh/profiles/web/node_modules/dsh-chat-import/index.mjs?dshr=3f70785fa603): '
  + 'tool "import_claude" is already registered (for a per-agent variant, register through that agent\'s `agent.ctx` instead)',
)

const BARE_ERROR = new Error(
  'failed to apply loader entry include (cordis:include): failed to apply loader entry import-claude '
  + '(dsh-chat-import): tool "import_claude" is already registered',
)

test('collisionPackage extracts the package from a cache-busted entry URL', () => {
  assert.equal(collisionPackage(REAL_ERROR), 'dsh-chat-import')
})

test('collisionPackage still extracts a bare package name', () => {
  assert.equal(collisionPackage(BARE_ERROR), 'dsh-chat-import')
})

test('collisionPackage returns undefined for unrelated errors', () => {
  assert.equal(collisionPackage(new Error('boom: something else happened')), undefined)
  assert.equal(collisionPackage(new Error('failed to apply loader entry include (cordis:include): ENOENT')), undefined)
})

/** Minimal loader-tree mock: root group + a nested market hot-mount row. */
function mockLoader() {
  const disposed = []
  const mktRow = {
    options: { id: 'mkt-import-claude', name: 'dsh-chat-import' },
    parent: {
      remove(id) {
        disposed.push(id)
      },
    },
  }
  const marketRow = { options: { id: 'dsh-market', name: 'dshmarket' } }
  const bundleRow = { options: { id: 'import-claude', name: 'dsh-chat-import' } }
  return {
    loader: {
      entries() {
        return [marketRow, bundleRow, mktRow][Symbol.iterator]()
      },
    },
    disposed,
  }
}

test('disposeMarketHotMounts removes the live mkt-* row for the colliding package only', async () => {
  const { loader, disposed } = mockLoader()
  const removed = await disposeMarketHotMounts({ get: () => loader }, 'dsh-chat-import')
  assert.deepEqual(removed, ['mkt-import-claude'])
  assert.deepEqual(disposed, ['mkt-import-claude'])
})

test('disposeMarketHotMounts leaves other packages alone', async () => {
  const { loader, disposed } = mockLoader()
  const removed = await disposeMarketHotMounts({ get: () => loader }, 'some-other-plugin')
  assert.deepEqual(removed, [])
  assert.deepEqual(disposed, [])
})

test('disposeMarketHotMounts tolerates a missing loader service', async () => {
  const removed = await disposeMarketHotMounts({ get: () => undefined }, 'dsh-chat-import')
  assert.deepEqual(removed, [])
})
