// e2e fixture v1 — registers a probe tool and writes a marker file so the
// test can tell which code generation actually ran.
import { writeFileSync } from 'node:fs'

export const name = 'e2e-update-bundle'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register({
    name: 'update_probe',
    description: 'e2e update probe (v1)',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: async () => ({ ok: true }),
  })
  writeFileSync(process.env.DSH_E2E_UPDATE_MARK, 'v1')
}
