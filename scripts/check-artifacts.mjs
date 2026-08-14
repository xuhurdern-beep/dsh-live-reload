/**
 * Guards on the shipped client artifact (run by `npm run check`):
 *
 * 1. The sourcemap must not leak absolute local paths — publishing the map
 *    would otherwise expose the build machine's directory structure.
 * 2. The bundle must consume the theme's real `--dsw-alias-*` tokens and
 *    must not carry the guessed `--dsh-color-*` names (verified against the
 *    client Theme service registry in `@deepseek-ai/dsh-client-ui-theme`).
 *
 * Exit code is non-zero when any guard fails.
 */
import { readFileSync } from 'node:fs'

const bundle = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const map = JSON.parse(readFileSync(new URL('../client/client.js.map', import.meta.url), 'utf8'))

let failures = 0
const fail = (message) => { failures += 1; console.error(`  ✗ ${message}`) }
const check = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`)
  else fail(message)
}

// --- 1. sourcemap path hygiene -------------------------------------------
const sources = (map.sources ?? []).map(source => String(source))
const absolute = sources.filter(source => /^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('/'))
check(absolute.length === 0, `sourcemap sources are relative (${sources.length} source(s))`)
const serialized = JSON.stringify(map)
const leaked = serialized.match(/[a-zA-Z]:[\\/][^"\\]+/g) ?? []
check(leaked.length === 0, `sourcemap contains no absolute local paths (${leaked.length} leak(s))`)

// --- 2. real theme tokens ------------------------------------------------
const aliasTokens = [...new Set(bundle.match(/--dsw-alias-[a-z0-9-]+/g) ?? [])]
check(aliasTokens.length > 0, `bundle references real theme tokens (${aliasTokens.join(', ') || 'none'})`)
const guessed = bundle.match(/--dsh-color-[a-z0-9-]+/g) ?? []
check(guessed.length === 0, `bundle has no guessed --dsh-color-* tokens (${guessed.length} found)`)

console.log(failures === 0 ? '\nARTIFACTS: PASS ✓' : `\nARTIFACTS: ${failures} check(s) FAILED ✗`)
process.exit(failures === 0 ? 0 : 1)
