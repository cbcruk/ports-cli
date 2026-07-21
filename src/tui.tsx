import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { createCollector, killPid, fmtKill, openPort, type Row } from './core.ts'
import { sortRows, filterRows, filterSystem, resolveSelection, rowCells, headerCells, SORT_KEYS, FW_COLOR, type SortKey } from './view.ts'

type Collect = () => Promise<Row[]>

type Props = { collect?: Collect; intervalMs?: number; showAll?: boolean }

/**
 * The live Ink TUI: a self-refreshing table of localhost dev servers with
 * keyboard-driven select, kill, open, sort, and filter.
 *
 * Polls `collect` every `intervalMs`, re-sorting and re-filtering each tick.
 * Selection and pending kills are anchored to a pid (not a row index) so a
 * refresh landing mid-interaction can't retarget the wrong process. `k`/`x`
 * arm a `y`/`n` confirmation before signalling.
 *
 * @param props.collect data source; defaults to a real {@link createCollector}
 * @param props.intervalMs refresh interval in ms (default `1500`)
 * @param props.showAll include system/GUI/ephemeral listeners (default `false`)
 */
export function App({ collect, intervalMs = 1500, showAll = false }: Props) {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const collectRef = useRef<Collect | null>(collect ?? null)
  if (!collectRef.current) collectRef.current = createCollector().collect
  const [rows, setRows] = useState<Row[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('port')
  // Anchored on pid, not index: the list re-sorts every tick (CPU order is volatile)
  // and an index would silently drift onto a different process before you hit `k`.
  const [selectedPid, setSelectedPid] = useState<number | null>(null)
  const lastIdx = useRef(0)
  const [filter, setFilter] = useState('')
  const [typing, setTyping] = useState(false)
  const [pending, setPending] = useState<{ pid: number; port: number; force: boolean } | null>(null)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    // A slow collect() (many listeners, sluggish lsof) can outlast the interval.
    // Skip overlapping ticks so concurrent collects can't corrupt the shared
    // CPU baseline / cwd cache inside the collector.
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const r = await collectRef.current!()
        if (alive) { setRows(r); setErr('') }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight = false
      }
    }
    void tick()
    const id = setInterval(() => void tick(), intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [intervalMs])

  const view = filterRows(sortRows(filterSystem(rows, showAll), sortKey), filter)

  const sel = resolveSelection(view, selectedPid, lastIdx.current)
  lastIdx.current = sel
  const target: Row | undefined = view[sel]

  useInput((input, key) => {
    if (typing) {
      if (key.escape) { setTyping(false); setFilter('') }
      else if (key.return) setTyping(false)
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1))
      else if (input && !key.ctrl && !key.meta) setFilter((f) => f + input)
      return
    }
    // A kill is armed and waiting on y/n — resolve it before anything else.
    if (pending) {
      if (input === 'y') {
        const { pid, port, force } = pending
        setStatus(`${force ? 'SIGKILL' : 'SIGTERM'} → :${port} …`)
        void killPid(pid, force).then((o) => setStatus(fmtKill(o, port, pid, force)))
      } else {
        setStatus('cancelled')
      }
      setPending(null)
      return
    }

    if (input === 'q' || (key.ctrl && input === 'c')) return exit()
    if (key.upArrow) setSelectedPid(view[Math.max(0, sel - 1)]?.pid ?? null)
    else if (key.downArrow) setSelectedPid(view[Math.min(view.length - 1, sel + 1)]?.pid ?? null)
    else if (input === 's') setSortKey((k) => SORT_KEYS[(SORT_KEYS.indexOf(k) + 1) % SORT_KEYS.length])
    else if (input === '/') { setTyping(true); setFilter('') }
    else if (input === 'k' || input === 'x') {
      // Arm against the pid resolved *now*, so a tick landing mid-confirm can't retarget it.
      if (target) setPending({ pid: target.pid, port: target.port, force: input === 'x' })
    } else if (input === 'o') {
      if (target) { openPort(target.port); setStatus(`open http://localhost:${target.port}`) }
    }
  }, { isActive: Boolean(isRawModeSupported) })

  const hdr = headerCells()

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">🔌 ports </Text>
        <Text color="gray">{view.length} listening · sort:{sortKey}{filter ? ` · /${filter}` : ''}</Text>
      </Box>

      <Text bold color="gray" wrap="truncate-end">{'  ' + hdr.join(' ')}</Text>

      {view.length === 0 && !err && <Text color="gray">  no dev servers listening on localhost</Text>}
      {err && <Text color="red">  {err.includes('lsof') ? 'lsof not found — required on macOS/Linux' : err}</Text>}

      {view.map((r, i) => {
        const c = rowCells(r)
        const isSel = i === sel
        return (
          <Text key={r.pid} inverse={isSel} wrap="truncate-end">
            {isSel ? '▸ ' : '  '}
            {c[0]} {' '}
            <Text color={isSel ? undefined : FW_COLOR[r.framework] ?? 'white'}>{c[1]}</Text>{' '}
            {c[2]} {c[3]} {c[4]} {c[5]} {c[6]} {c[7]}
          </Text>
        )
      })}

      <Box marginTop={1}>
        {pending ? (
          <Text color="red" bold>
            {pending.force ? 'SIGKILL' : 'SIGTERM'} :{pending.port} (pid {pending.pid})? y/n
          </Text>
        ) : (
          <Text color="gray">
            {typing
              ? `filter: ${filter}▏  (enter apply · esc clear)`
              : '↑↓ select · k kill · x force · o open · s sort · / filter · q quit'}
          </Text>
        )}
      </Box>
      {status && !typing && !pending && <Text color="yellow">  {status}</Text>}
    </Box>
  )
}
