/**
 * dsh-live-reload — client half.
 *
 * Renders a "Plugin Refresh / 插件刷新" settings section: shows the booted
 * profile and the last refresh result, and triggers a restart-free
 * composition refresh through the host's `/dsh-live-reload/refresh` route.
 * When the refresh changed the client plugin graph (new client bundles), the
 * section offers a page reload — the host process itself never exits.
 *
 * The bundle is built by tsdown (see tsdown.config.js) into the
 * `window.__ModuleLoader__.load({ id, factory })` artifact; `react` and
 * `react/jsx-runtime` resolve from the loader's frozen module table. No other
 * plugin package is imported — the UI is plain HTML elements with inline
 * styles, so it works across UI-primitive versions.
 *
 * @module dsh-live-reload/client
 */

import { createElement as h, useEffect, useState } from 'react'

export const name = 'dsh-live-reload'

/** Hard dependency: the client slots service (provided by the ui-slots platform module). */
export const inject = ['slots']

const NS = 'dsh-live-reload'

/** One settings page inside Settings → "Plugin Refresh". */
const SECTION_ID = 'live-reload'

/** Small inline style helpers (theme-independent, neutral palette). */
const styles = {
  card: {
    display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px',
    border: '1px solid var(--dsh-color-border, rgba(128,128,128,.3))',
    borderRadius: '8px', maxWidth: '560px', fontSize: '13px', lineHeight: 1.5,
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  button: {
    padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--dsh-color-border, rgba(128,128,128,.4))',
    background: 'var(--dsh-color-surface-2, rgba(128,128,128,.12))', cursor: 'pointer', fontSize: '13px',
  },
  primary: {
    padding: '6px 14px', borderRadius: '6px', border: '1px solid transparent',
    background: 'var(--dsh-color-accent, #4a6cf7)', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  muted: { color: 'var(--dsh-color-text-2, rgba(128,128,128,.85))', fontSize: '12px' },
  list: { margin: 0, paddingLeft: '18px', fontSize: '12px' },
  error: { color: '#d9534f', fontSize: '12px', whiteSpace: 'pre-wrap' },
}

/** The one-click refresh section body. */
function LiveReloadSection() {
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const loadStatus = () => {
    fetch('/dsh-live-reload/status')
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => { /* route may be missing while the plugin is mid-boot */ })
  }

  useEffect(() => { loadStatus() }, [])

  const refresh = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/dsh-live-reload/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const data = await res.json()
      setResult(data)
      loadStatus()
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(false)
    }
  }

  const profile = status?.profile ?? '…'
  const last = status?.last
  const lastText = last !== null && last !== undefined
    ? `${new Date(last.at).toLocaleTimeString()} · ${last.ok ? '✓' : '✗'} (+${last.added.length} −${last.removed.length} ~${last.updated.length})`
    : '—'

  return h('div', { style: styles.card },
    h('div', { style: styles.row },
      h('span', null, '插件刷新 · Plugin Refresh'),
      h('span', { style: styles.muted }, `profile: ${profile}`),
      h('span', { style: styles.muted }, `上次: ${lastText}`),
    ),
    h('div', { style: styles.row },
      h('button', {
        style: styles.primary,
        disabled: busy || status?.refreshing === true,
        onClick: refresh,
      }, busy ? '刷新中…' : '一键刷新插件 / Refresh Plugins'),
    ),
    error !== null && h('pre', { style: styles.error }, error),
    result !== null && h(ResultPanel, { result }),
  )
}

/** Renders one refresh result: added / removed / updated rows + errors + reload hint. */
function ResultPanel({ result }) {
  const ok = result.ok === true
  const lines = []
  if (!ok && Array.isArray(result.errors)) lines.push(`错误 / errors:\n${result.errors.join('\n')}`)
  if (result.added?.length > 0) lines.push(`新增 / added: ${result.added.join(', ')}`)
  if (result.removed?.length > 0) lines.push(`移除 / removed: ${result.removed.join(', ')}`)
  if (result.updated?.length > 0) lines.push(`更新 / updated: ${result.updated.join(', ')}`)
  if (lines.length === 0) lines.push('无变化 / no changes')

  const needsReload = ok && result.clientGraphChanged === true

  return h('div', null,
    h('div', { style: { color: ok ? '#3c9d5b' : '#d9534f', fontSize: '12px', fontWeight: 600 } },
      ok ? '✓ 已热刷新，进程未退出 / refreshed live, process kept running' : '✗ 刷新失败 / refresh failed'),
    h('ul', { style: styles.list }, lines.map((line, index) => h('li', { key: index }, line))),
    needsReload && h('div', { style: styles.row },
      h('span', { style: styles.muted }, '有新的客户端插件出现，刷新页面以加载（宿主进程不退出）:'),
      h('button', { style: styles.button, onClick: () => location.reload() }, '刷新页面 / Reload Page'),
    ),
  )
}

/**
 * Cordis client plugin entry: register the settings section.
 * @param {{get(name: string): unknown, effect(cb: () => unknown, label?: string): void}} ctx
 */
export function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: SECTION_ID,
      order: 50,
      label: () => '插件刷新 / Plugin Refresh',
    },
    () => h(LiveReloadSection, {}),
  )), `${NS}: settings section`)
}
