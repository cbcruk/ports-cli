/**
 * View logic for the terminal table: sorting, filtering, selection, and the
 * plain-string cell layout the Ink layer colors.
 *
 * Everything here is pure, so the table can be asserted on as text without
 * rendering a terminal.
 *
 * @example Build the visible rows for one frame
 * ```ts
 * import { createCollector } from './core.ts'
 * import { filterSystem, sortRows, filterRows, rowCells, formatLine } from './view.ts'
 *
 * const rows = await createCollector().collect()
 * const view = filterRows(sortRows(filterSystem(rows, false), 'cpu'), 'vite')
 * for (const r of view) console.log(formatLine(rowCells(r), process.stdout.columns))
 * ```
 *
 * @module
 */
import { type Row, fmtUptime, fmtCpu, isSystemProcess, isEphemeralOnly } from './core.ts'

/** Column the list can be ordered by. */
export type SortKey = 'port' | 'cpu' | 'mem' | 'uptime'

/** Every {@link SortKey}, in the order the `s` key cycles through them. */
export const SORT_KEYS: SortKey[] = ['port', 'cpu', 'mem', 'uptime']

/**
 * Returns a new array of rows sorted by the given key.
 *
 * `port` sorts ascending; every other key sorts descending (busiest first),
 * with `null` CPU treated as lowest so idle-unknown rows sink to the bottom.
 * The input is not mutated.
 *
 * @param rows rows to sort
 * @param key column to sort by
 * @returns a sorted copy of `rows`
 */
export function sortRows(rows: Row[], key: SortKey): Row[] {
  const by = [...rows]
  by.sort((a, b) => {
    switch (key) {
      case 'port': return a.port - b.port
      case 'cpu': return (b.cpu ?? -1) - (a.cpu ?? -1)
      case 'mem': return b.memMB - a.memMB
      case 'uptime': return b.uptimeSecs - a.uptimeSecs
    }
  })
  return by
}

/**
 * Filters rows by a free-text query, case-insensitively matching against any
 * listening port, the framework, the project, or the full command.
 *
 * @param rows rows to filter
 * @param q search text; an empty string passes every row through unchanged
 * @returns the matching rows
 */
export function filterRows(rows: Row[], q: string): Row[] {
  if (!q) return rows
  const n = q.toLowerCase()
  return rows.filter(
    (r) =>
      r.ports.some((p) => String(p).includes(n)) ||
      r.framework.toLowerCase().includes(n) ||
      r.project.toLowerCase().includes(n) ||
      r.command.toLowerCase().includes(n),
  )
}

/**
 * Drops OS daemons, GUI apps, and ephemeral-only listeners so the view shows
 * just real dev servers.
 *
 * @param rows rows to filter
 * @param showAll when `true`, disables filtering and returns everything
 * @returns the visible rows
 */
export function filterSystem(rows: Row[], showAll: boolean): Row[] {
  if (showAll) return rows
  return rows.filter((r) => !isSystemProcess(r.command) && !isEphemeralOnly(r.ports))
}

/**
 * Resolves which row index the cursor should sit on, anchoring selection to a
 * pid rather than a slot.
 *
 * The list re-sorts every tick on volatile keys, so tracking by pid keeps the
 * cursor on the same process across reorders. If that pid is gone (killed or
 * filtered out), it holds the previous slot (clamped) instead of snapping to
 * the top.
 *
 * @param rows current visible rows
 * @param pid the selected process id, or `null` to fall back to `lastIdx`
 * @param lastIdx index held on the previous frame
 * @returns the index to select (`0` when `rows` is empty)
 *
 * @example The cursor follows the pid, not the slot
 * ```ts
 * import { sortRows, resolveSelection } from './view.ts'
 *
 * const rows = sortRows(collected, 'cpu') // pid 10 was at index 0 last frame
 * resolveSelection(rows, 10, 0) // its new index — same process, new position
 * resolveSelection(rows, -1, 3) // 3, clamped — that pid is gone, so hold the slot
 * ```
 */
export function resolveSelection(rows: Row[], pid: number | null, lastIdx: number): number {
  if (!rows.length) return 0
  const i = rows.findIndex((r) => r.pid === pid)
  return i >= 0 ? i : Math.min(Math.max(0, lastIdx), rows.length - 1)
}

/**
 * Formats a row's port cell, summarising a multi-port process as
 * `"<primary> +<n>"` (e.g. `"9229 +2"`) and a single port as its number.
 *
 * @param r the row
 * @returns the port-cell text
 */
export function fmtPorts(r: Row): string {
  return r.ports.length > 1 ? `${r.port} +${r.ports.length - 1}` : String(r.port)
}

/** Left-aligns `s` to width `w`, truncating with an ellipsis when it overflows. */
const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w))
/** Right-aligns `s` to width `w`, hard-truncating (no ellipsis) when it overflows. */
const padL = (s: string, w: number) => (s.length > w ? s.slice(0, w) : s.padStart(w))

/** Fixed cell widths in characters, for every column but the trailing command. */
export const COLS = { port: 9, fw: 9, project: 16, pid: 7, cpu: 6, mem: 8, up: 7 }

/**
 * Builds the aligned header cells matching the column widths in {@link COLS}.
 *
 * @returns one padded string per column, in row order
 */
export function headerCells(): string[] {
  return [
    pad('PORT', COLS.port), pad('FRAMEWORK', COLS.fw), pad('PROJECT', COLS.project),
    padL('PID', COLS.pid), padL('CPU%', COLS.cpu), padL('MEM MB', COLS.mem),
    padL('UP', COLS.up), 'COMMAND',
  ]
}

/**
 * Renders one row into aligned, fixed-width cells.
 *
 * The strings stay plain (and thus unit-testable) — the Ink layer applies
 * color. The trailing command cell is left untruncated; {@link formatLine} or
 * the terminal clips it.
 *
 * @param r the row to render
 * @returns one padded string per column, in header order
 */
export function rowCells(r: Row): string[] {
  return [
    pad(fmtPorts(r), COLS.port),
    pad(r.framework, COLS.fw),
    pad(r.project || '—', COLS.project),
    padL(String(r.pid), COLS.pid),
    padL(fmtCpu(r.cpu), COLS.cpu),
    padL(r.memMB.toFixed(0), COLS.mem),
    padL(fmtUptime(r.uptimeSecs), COLS.up),
    r.command,
  ]
}

/**
 * Joins cells with single spaces and hard-truncates the result to the terminal
 * width so a GUI app's multi-thousand-char argv can't wrap the display.
 *
 * @param cells the cells to join (typically from {@link rowCells})
 * @param width maximum line width in columns
 * @returns the joined line, ellipsised if it exceeds `width`
 */
export function formatLine(cells: string[], width: number): string {
  const line = cells.join(' ')
  return line.length > width ? line.slice(0, Math.max(1, width - 1)) + '…' : line
}

/**
 * Ink color for each framework name, used to tint the FRAMEWORK cell.
 *
 * Keys are exactly what `detectFramework` returns, `'—'` fallback included, so
 * a lookup never misses for a row built by the collector.
 */
export const FW_COLOR: Record<string, string> = {
  'Next.js': 'white', SvelteKit: 'red', Vite: 'magenta', Nuxt: 'green', Astro: 'red',
  Gatsby: 'magenta', Angular: 'red', Storybook: 'magenta', Webpack: 'blue', Remix: 'cyan',
  Expo: 'blue', Workers: 'yellow', Bun: 'yellow', Deno: 'green',
  Rails: 'red', Python: 'blue', Go: 'cyan', Node: 'green', '—': 'gray',
}
