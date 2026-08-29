/**
 * The stateful half of the data layer: turns `lsof` and `ps` into {@link Row}s.
 *
 * Kept apart from the parsers because this is the only piece that holds state
 * between calls — the previous CPU sample and the cwd cache.
 *
 * @module
 */
import type { Collector, Exec, Row } from './core.types.ts'
import { defaultExec } from './exec.ts'
import { detectFramework, parseCwd, parseListeners, parsePs } from './parsers.ts'

/**
 * Builds a stateful collector that snapshots current localhost listeners.
 *
 * The returned `collect` is stateful across calls: it retains the previous CPU
 * sample so it can report an instantaneous %CPU as a delta, and caches each
 * pid's cwd so the project name is resolved only once.
 *
 * @param exec command runner (defaults to a real `execFile`); inject to test
 * @returns a collector whose `collect()` shares one CPU baseline across calls
 *
 * @example Two ticks, one baseline
 * ```ts
 * import { createCollector } from './collector.ts'
 *
 * const { collect } = createCollector()
 * await collect() // every row's `cpu` is null — nothing to diff against yet
 * await new Promise((r) => setTimeout(r, 1500))
 * await collect() // `cpu` is now a real percentage
 * ```
 */
export function createCollector(exec: Exec = defaultExec): Collector {
  let prev = new Map<number, { cpuSecs: number; wallMs: number }>()
  const cwdCache = new Map<number, string>()

  /**
   * Enumerates and enriches every localhost listener into a {@link Row}[].
   *
   * Runs `lsof` for listeners, one batched `ps` for stats, and `lsof -d cwd`
   * for uncached pids, then diffs CPU-time against the prior call for a live
   * %CPU (`null` on the first sample). Rows are collapsed one-per-pid and
   * sorted ascending by primary port.
   *
   * @returns the current rows, or `[]` when nothing is listening
   */
  async function collect(): Promise<Row[]> {
    const listenersOut = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    const listeners = parseListeners(listenersOut)
    const pids = [...listeners.keys()]
    if (pids.length === 0) {
      prev = new Map()
      return []
    }

    const psOut = await exec('ps', ['-p', pids.join(','), '-o', 'pid=,rss=,etime=,time=,command='])
    const stats = parsePs(psOut)

    const uncached = pids.filter((p) => !cwdCache.has(p))
    if (uncached.length) {
      const cwdOut = await exec('lsof', ['-p', uncached.join(','), '-a', '-d', 'cwd', '-Fn'])
      for (const [p, name] of parseCwd(cwdOut)) cwdCache.set(p, name)
    }

    const wallMs = Date.now()
    const next = new Map<number, { cpuSecs: number; wallMs: number }>()
    const rows: Row[] = []

    for (const [pid, { command, ports }] of listeners) {
      const st = stats.get(pid)
      if (!st) continue
      const cmd = st.command || command
      next.set(pid, { cpuSecs: st.cpuSecs, wallMs })
      const p = prev.get(pid)
      const dt = p ? (wallMs - p.wallMs) / 1000 : 0
      const cpu = p && dt > 0 ? Math.max(0, ((st.cpuSecs - p.cpuSecs) / dt) * 100) : null

      const sorted = [...ports].sort((a, b) => a - b)
      if (!sorted.length) continue
      rows.push({
        port: sorted[0],
        ports: sorted,
        pid,
        command: cmd,
        framework: detectFramework(cmd),
        project: cwdCache.get(pid) ?? '',
        cpu,
        memMB: st.rss / 1024,
        uptimeSecs: st.etime,
      })
    }
    prev = next
    return rows.sort((a, b) => a.port - b.port)
  }

  return { collect }
}
