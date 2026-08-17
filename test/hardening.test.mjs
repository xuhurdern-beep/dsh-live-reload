/**
 * Unit coverage for the refresh hardening helpers:
 * - `packageFileUrls` — the module-cache keys an in-place update can stale.
 * - `evictBustedPackages` — evicts a busted package's cached modules (entry
 *   URL AND relative deps) from the Node internal loadCache.
 * - `collectErrorChain` — flattens cause / AggregateError chains so wrapped
 *   failures ("failed to rollback ...: " with an empty AggregateError
 *   message) never hide the underlying reason.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectErrorChain, evictBustedPackages, packageFileUrls } from '../src/index.js'

/** One throwaway package dir with a couple of files + nested junk. */
function tempPackage() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lr-test-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), '')
  writeFileSync(join(dir, 'lib', 'dep.mjs'), '')
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '')
  writeFileSync(join(dir, '.git', 'HEAD'), '')
  return dir
}

test('packageFileUrls walks files and skips node_modules/.git', () => {
  const dir = tempPackage()
  try {
    const urls = packageFileUrls(dir)
    assert.deepEqual(urls, [
      pathToFileURL(join(dir, 'index.mjs')).href,
      pathToFileURL(join(dir, 'lib', 'dep.mjs')).href,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evictBustedPackages clears the entry URL and every file URL', () => {
  const dir = tempPackage()
  try {
    const cache = new Map()
    for (const url of packageFileUrls(dir)) cache.set(url, {})
    const bustedUrl = pathToFileURL(join(dir, 'index.mjs')).href + '?dshr=rev1'
    cache.set(bustedUrl, {})
    const loader = { internal: { loadCache: cache } }
    const requireProfile = { resolve: () => join(dir, 'package.json') }
    const bustedNames = new Map([['pkg-a', bustedUrl]])

    const evicted = evictBustedPackages({ get: () => loader }, requireProfile, bustedNames)
    assert.deepEqual(evicted, ['pkg-a'])
    for (const url of packageFileUrls(dir)) assert.ok(!cache.has(url), `expected evicted: ${url}`)
    assert.ok(!cache.has(bustedUrl), 'busted entry URL evicted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evictBustedPackages tolerates a missing loader or unresolvable package', () => {
  assert.deepEqual(evictBustedPackages({ get: () => undefined }, {}, new Map([['pkg', 'u']])), [])
  const dir = tempPackage()
  try {
    const busted = new Map([['nope', 'u']])
    const requireProfile = { resolve: () => { throw new Error('not found') } }
    assert.deepEqual(evictBustedPackages({ get: () => ({ internal: { loadCache: new Map() } }) }, requireProfile, busted), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectErrorChain flattens causes and AggregateError.errors', () => {
  const inner = new Error('tool "import_claude" is already registered')
  const aggregate = new AggregateError([inner, new Error('webserver: duplicate prefix route "/x"')])
  const wrapped = new Error('failed to rollback loader entry include (cordis:include): ', { cause: aggregate })
  assert.deepEqual(collectErrorChain(wrapped), [
    'failed to rollback loader entry include (cordis:include): ',
    'tool "import_claude" is already registered',
    'webserver: duplicate prefix route "/x"',
  ])
})

test('collectErrorChain guards cycles and depth', () => {
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  // @ts-expect-error -- deliberate cycle
  a.cause = b
  assert.deepEqual(collectErrorChain(b), ['b', 'a'])

  const deep = new Error('0')
  let cur = deep
  for (let i = 1; i <= 8; i += 1) { cur = new Error(String(i), { cause: cur }) }
  const chain = collectErrorChain(cur)
  assert.ok(chain.length <= 6, `depth-capped: ${chain.length}`)
})
