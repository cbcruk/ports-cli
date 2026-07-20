import { type Row, fmtUptime, fmtCpu, isSystemProcess } from './core.ts'

export type SortKey = 'port' | 'cpu' | 'mem' | 'uptime'
export const SORT_KEYS: SortKey[] = ['port', 'cpu', 'mem', 'uptime']

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

export function filterRows(rows: Row[], q: string): Row[] {
  if (!q) return rows
  const n = q.toLowerCase()
  return rows.filter(
    (r) =>
      String(r.port).includes(n) ||
      r.framework.toLowerCase().includes(n) ||
      r.project.toLowerCase().includes(n) ||
      r.command.toLowerCase().includes(n),
  )
}

export function filterSystem(rows: Row[], showAll: boolean): Row[] {
  return showAll ? rows : rows.filter((r) => !isSystemProcess(r.command))
}

const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w))
const padL = (s: string, w: number) => (s.length > w ? s.slice(0, w) : s.padStart(w))

export const COLS = { port: 5, fw: 9, project: 16, pid: 7, cpu: 6, mem: 8, up: 7 }

export function headerCells(): string[] {
  return [
    pad('PORT', COLS.port), pad('FRAMEWORK', COLS.fw), pad('PROJECT', COLS.project),
    padL('PID', COLS.pid), padL('CPU%', COLS.cpu), padL('MEM MB', COLS.mem),
    padL('UP', COLS.up), 'COMMAND',
  ]
}

// One row → aligned cells (the Ink layer colors them; strings here are testable)
export function rowCells(r: Row): string[] {
  return [
    pad(String(r.port), COLS.port),
    pad(r.framework, COLS.fw),
    pad(r.project || '—', COLS.project),
    padL(String(r.pid), COLS.pid),
    padL(fmtCpu(r.cpu), COLS.cpu),
    padL(r.memMB.toFixed(0), COLS.mem),
    padL(fmtUptime(r.uptimeSecs), COLS.up),
    r.command,
  ]
}

// Joined line, hard-truncated to the terminal width (argv of GUI apps runs to thousands of chars).
export function formatLine(cells: string[], width: number): string {
  const line = cells.join(' ')
  return line.length > width ? line.slice(0, Math.max(1, width - 1)) + '…' : line
}

export const FW_COLOR: Record<string, string> = {
  'Next.js': 'white', Vite: 'magenta', Nuxt: 'green', Astro: 'red',
  Webpack: 'blue', Remix: 'cyan', Workers: 'yellow', Bun: 'yellow', Deno: 'green',
  Rails: 'red', Python: 'blue', Go: 'cyan', Node: 'green', '—': 'gray',
}
