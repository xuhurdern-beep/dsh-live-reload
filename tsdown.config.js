/**
 * tsdown config for the client bundle — emits the module-loader artifact
 * (`window.__ModuleLoader__.load({ id, factory })`) that the dsh web client
 * fetches from /plugins/dsh-live-reload/client.js.
 *
 * Mirrors the harness's own client-bundle preset (banner/footer/intro,
 * externals = the frozen platform module table, everything else inlined,
 * `process.env`/`import.meta.env` substitutions) so the shipped artifact
 * satisfies the client-modules contract without a monorepo dependency.
 */
import { defineConfig } from 'tsdown'

/** The frozen module table the browser shell shares into the loader. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

export default defineConfig({
  name: 'dsh-live-reload/client',
  entry: { client: 'src/client/index.js' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: true,
  // Platform modules stay external (resolved from the loader's frozen module
  // table); everything else is inlined — a require() the table cannot answer
  // is a guaranteed runtime throw.
  deps: {
    alwaysBundle: (id) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Anything not in the module table must be inlined — a require() the table
  // cannot answer is a guaranteed runtime throw.
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-live-reload", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
