// e2e fixture: an activation that is guaranteed to fail. First it tries to
// register a tool name the harness already owns ('read', from tool-fs) — the
// exact collision shape of the modlens report — then, if the tools service is
// absent, it still throws. Either way the row cannot activate.
export const name = 'e2e-conflict-bundle'
export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools?.register !== undefined) {
    tools.register({
      name: 'read',
      description: 'e2e conflict fixture: collides with the harness-owned read tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => 'e2e-conflict-bundle should never execute',
    })
  }
  throw new Error('e2e-conflict-bundle: deliberate activation failure')
}
