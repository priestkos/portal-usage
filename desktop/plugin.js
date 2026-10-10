/**
 * Portal Usage — desktop status-bar chip.
 *
 * Shows usage limits and remaining budget for the three billing portals this
 * machine runs against (OpenCode Go, OpenRouter, Nous Portal). Click the chip
 * for all three at once.
 *
 * Two readouts, switchable in the panel and remembered via ctx.storage:
 *   A  Budget   — the numbers each portal actually publishes (%, $)
 *   B  Context  — tokens left in the focused chat's context window
 *
 * Loaded uncompiled: jsx() calls only, and the only importable specifiers are
 * @hermes/plugin-sdk, react and react/jsx-runtime.
 */

import {
  atom, Button, cn, host, Popover, PopoverContent, PopoverTrigger,
  SegmentedControl, useQuery, useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'portal-usage'

const MODES = [
  { id: 'a', label: 'Budget' },
  { id: 'b', label: 'Context' }
]

/** Short labels for the three portals, in the order the backend returns them. */
const SHORT = { 'opencode-go': 'GO', openrouter: 'OR', nous: 'NS' }

// Set by the refresh button; consumed once by the next queryFn so a manual
// refresh bypasses the backend's 60s cache without changing the query key.
const forceRefresh = { value: false }

// --------------------------------------------------------------------------- //
// formatting
// --------------------------------------------------------------------------- //

function fmtUsd(value) {
  if (typeof value !== 'number') return '—'
  const abs = Math.abs(value)
  return `$${abs >= 1000 ? Math.round(value) : value.toFixed(2)}`
}

function fmtTokens(value) {
  if (typeof value !== 'number') return '—'
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [scale, suffix] of units) {
    if (Math.abs(value) >= scale) {
      const scaled = value / scale
      const text = scaled < 10 ? scaled.toFixed(2) : scaled < 100 ? scaled.toFixed(1) : String(Math.round(scaled))
      return `${text.replace(/\.0+$/, '')}${suffix}`
    }
  }
  return String(Math.round(value))
}

function fmtPct(value) {
  return typeof value === 'number' ? `${Math.round(value)}%` : '—'
}

function fmtReset(iso) {
  if (!iso) return null
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return null
  const seconds = Math.round((when.getTime() - Date.now()) / 1000)
  if (seconds <= 0) return 'due now'
  const units = [[86400, 'd'], [3600, 'h'], [60, 'm']]
  for (const [scale, suffix] of units) {
    if (seconds >= scale) return `in ${Math.floor(seconds / scale)}${suffix}`
  }
  return `in ${seconds}s`
}

function fmtTime(iso) {
  if (!iso) return ''
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The headline budget number a portal publishes, most-authoritative first. */
function headlineUsd(portal) {
  const money = portal.money || {}
  for (const key of ['balance_usd', 'total_usable_usd', 'remaining_usd']) {
    if (typeof money[key] === 'number') return money[key]
  }
  const monthly = (portal.windows || []).find(w => /month|subscription/i.test(w.label || ''))
  if (monthly && typeof monthly.remaining_percent === 'number') return monthly.remaining_percent
  return null
}

/** Compact per-mode readout for one portal, used by the chip. */
function shortValue(portal) {
  const value = headlineUsd(portal)
  if (typeof value !== 'number') return '—'
  // Percent-only portals (OpenCode Go) report a fraction; the others report USD.
  const money = portal.money || {}
  const isUsd = ['balance_usd', 'total_usable_usd', 'remaining_usd'].some(k => typeof money[k] === 'number')
  return isUsd ? fmtUsd(value) : fmtPct(value)
}

// --------------------------------------------------------------------------- //
// data
// --------------------------------------------------------------------------- //

function useUsage(ctx) {
  const [tick, setTick] = useState(0)
  const query = useQuery({
    queryKey: ['portal-usage', tick],
    queryFn: () => {
      const suffix = forceRefresh.value ? '?refresh=1' : ''
      forceRefresh.value = false
      return ctx.rest('/usage' + suffix)
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1
  })
  return { ...query, reload: () => { forceRefresh.value = true; setTick(t => t + 1) } }
}

// --------------------------------------------------------------------------- //
// chip
// --------------------------------------------------------------------------- //

function ContextReadout() {
  const usage = useValue(host.state.focusedUsage)
  if (!usage) return jsx('span', { children: 'ctx —' })
  const percent = typeof usage.context_percent === 'number' ? `${Math.round(usage.context_percent)}%` : '—'
  const window = usage.context_max
    ? `${fmtTokens(usage.context_used || 0)}/${fmtTokens(usage.context_max)}`
    : null
  return jsxs('span', {
    className: 'inline-flex items-center gap-1',
    children: [
      jsx('span', { className: 'text-(--ui-text-primary)', children: `ctx ${percent}` }),
      window ? jsx('span', { children: window }) : null
    ]
  })
}

function Chip({ ctx, mode }) {
  const current = useValue(mode)
  const { data, isError } = useUsage(ctx)

  if (current === 'b') {
    return jsx('span', {
      className: 'inline-flex h-full items-center gap-2 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
      children: jsx(ContextReadout, {})
    })
  }

  const portals = (data && data.portals) || []
  if (!portals.length) {
    return jsx('span', {
      className: 'inline-flex h-full items-center px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
      children: isError ? 'usage offline' : 'usage …'
    })
  }

  const parts = portals.map(portal =>
    jsxs('span', {
      className: 'inline-flex items-center gap-1',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: SHORT[portal.id] || portal.id }),
        jsx('span', {
          className: cn('tabular-nums', portal.ok ? 'text-(--ui-text-primary)' : 'text-(--ui-text-quaternary)'),
          children: portal.ok ? shortValue(portal) : '—'
        })
      ]
    })
  )

  return jsx('span', {
    className: 'inline-flex h-full items-center gap-2 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
    children: parts.flatMap((node, index) => (index === 0 ? [node] : [jsx('span', { 'aria-hidden': true, children: '·' }), node]))
  })
}

// --------------------------------------------------------------------------- //
// panel
// --------------------------------------------------------------------------- //

function WindowRow({ window }) {
  const reset = fmtReset(window.reset_at)
  let label = window.label || 'window'
  if (/^(Rolling window|Weekly|Monthly|API key quota|Subscription)$/i.test(label.trim())) {
    label = `${label.trim()} `
  }
  return jsxs('div', {
    className: 'pu-grid pu-row',
    children: [
      jsx('span', { children: label }),
      jsx('span', {
        className: 'pu-num',
        children: `${fmtPct(window.remaining_percent)} left${reset ? ` · resets ${reset}` : ''}`
      })
    ]
  })
}

function WindowBar({ window }) {
  const remaining = typeof window.remaining_percent === 'number' ? Math.max(0, Math.min(100, window.remaining_percent)) : 0
  return jsx('div', {
    className: 'pu-track',
    children: jsx('div', { className: 'pu-fill', style: { width: `${remaining}%` } })
  })
}

function PortalCard({ portal }) {
  const money = portal.money || {}
  const rows = portal.windows || []
  return jsxs('div', {
    className: 'pu-card',
    children: [
      jsxs('div', {
        className: 'pu-grid pu-head',
        children: [
          jsxs('span', {
            children: [
              jsx('strong', { children: portal.label }),
              portal.plan ? jsx('span', { className: 'pu-dim', children: ` · ${portal.plan}` }) : null
            ]
          }),
          jsx('span', {
            className: 'pu-num pu-strong',
            children: typeof money.balance_usd === 'number' ? fmtUsd(money.balance_usd) : fmtUsd(money.total_usable_usd)
          })
        ]
      }),
      portal.ok
        ? null
        : jsx('div', { className: 'pu-warn', children: portal.error || 'Unavailable' }),
      rows.length
        ? rows.map((window, index) => jsxs('div', {
            className: 'pu-block',
            children: [jsx(WindowBar, { window }), jsx(WindowRow, { window })]
          }, `${portal.id}-${index}`))
        : (portal.ok ? jsx('div', { className: 'pu-dim', children: 'No usage windows reported.' }) : null),
      (portal.details || []).length
        ? jsx('div', {
            className: 'pu-details',
            children: portal.details.map((line, index) => jsx('div', { children: line }, index))
          })
        : null
    ]
  })
}

function Panel({ ctx, mode }) {
  const current = useValue(mode)
  const { data, isError, error, isLoading, reload } = useUsage(ctx)
  const portals = (data && data.portals) || []

  return jsxs('div', {
    className: 'pu-panel',
    children: [
      jsxs('div', {
        className: 'pu-grid pu-head',
        children: [
          jsx('span', { className: 'pu-title', children: 'Portal usage' }),
          jsx(Button, {
            variant: 'ghost',
            size: 'micro',
            onClick: () => { reload() },
            children: isLoading ? 'Loading…' : 'Refresh'
          })
        ]
      }),
      jsx(SegmentedControl, {
        options: MODES,
        value: current,
        onChange: value => { mode.set(value); ctx.storage.set('mode', value) }
      }),
      isError
        ? jsx('div', { className: 'pu-warn', children: `Backend unreachable: ${(error && error.message) || 'unknown error'}` })
        : null,
      portals.length
        ? portals.map(portal => jsx(PortalCard, { portal }, portal.id))
        : jsx('div', { className: 'pu-dim', children: isLoading ? 'Loading…' : 'No data.' }),
      jsxs('div', {
        className: 'pu-grid pu-foot',
        children: [
          jsx('span', { children: '' }),
          jsx('span', { children: data && data.generated_at ? `updated ${fmtTime(data.generated_at)}` : '' })
        ]
      })
    ]
  })
}

// --------------------------------------------------------------------------- //
// chrome
// --------------------------------------------------------------------------- //

function PortalUsageBar({ ctx, mode }) {
  const [open, setOpen] = useState(false)
  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx('button', {
          type: 'button',
          'aria-label': 'Portal usage — OpenCode Go, OpenRouter, Nous Portal',
          className: 'inline-flex h-full items-center rounded-sm transition-colors hover:bg-(--chrome-action-hover)',
          children: jsx(Chip, { ctx, mode })
        })
      }),
      jsx(PopoverContent, {
        side: 'top',
        align: 'end',
        className: 'w-[360px] p-3',
        children: jsx(Panel, { ctx, mode })
      })
    ]
  })
}

const CSS = `
.pu-panel { display: flex; flex-direction: column; gap: 8px; font-size: 0.75rem; }
.pu-grid { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pu-head { margin-bottom: 2px; }
.pu-title { font-weight: 600; color: var(--ui-text-primary); }
.pu-num { font-variant-numeric: tabular-nums; color: var(--ui-text-secondary); }
.pu-strong { color: var(--ui-text-primary); font-weight: 600; }
.pu-dim { color: var(--ui-text-quaternary); }
.pu-card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--ui-stroke-secondary); border-radius: 8px; }
.pu-block { display: flex; flex-direction: column; gap: 3px; }
.pu-row { font-size: 0.6875rem; color: var(--ui-text-secondary); }
.pu-track { height: 3px; border-radius: 999px; background: var(--ui-bg-quaternary); overflow: hidden; }
.pu-fill { height: 100%; background: var(--ui-accent); }
.pu-details { display: flex; flex-direction: column; gap: 1px; font-size: 0.6875rem; color: var(--ui-text-tertiary); }
.pu-warn { color: var(--ui-text-secondary); font-size: 0.6875rem; }
.pu-foot { font-size: 0.625rem; color: var(--ui-text-quaternary); }
`

export default {
  id: ID,
  name: 'Portal Usage',
  description: 'Usage limits and remaining budget for OpenCode Go, OpenRouter and the Nous Portal.',
  register(ctx) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    const mode = atom(ctx.storage.get('mode', 'a'))
    if (!MODES.some(option => option.id === mode.get())) mode.set('a')

    ctx.register({
      id: 'portal-usage-chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(PortalUsageBar, { ctx, mode })
    })
  }
}
