import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { createCollector, killPid, openPort, type Row } from './core.ts'
import { sortRows, filterRows, filterSystem, rowCells, headerCells, SORT_KEYS, FW_COLOR, type SortKey } from './view.ts'

type Collect = () => Promise<Row[]>

type Props = { collect?: Collect; intervalMs?: number; showAll?: boolean }

export function App({ collect, intervalMs = 1500, showAll = false }: Props) {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const collectRef = useRef<Collect | null>(collect ?? null)
  if (!collectRef.current) collectRef.current = createCollector().collect
  const [rows, setRows] = useState<Row[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('port')
  const [selected, setSelected] = useState(0)
  const [filter, setFilter] = useState('')
  const [typing, setTyping] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await collectRef.current!()
        if (alive) { setRows(r); setErr('') }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void tick()
    const id = setInterval(() => void tick(), intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [intervalMs])

  const view = filterRows(sortRows(filterSystem(rows, showAll), sortKey), filter)
  const sel = Math.min(selected, Math.max(0, view.length - 1))

  useInput((input, key) => {
    if (typing) {
      if (key.escape) { setTyping(false); setFilter('') }
      else if (key.return) setTyping(false)
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1))
      else if (input && !key.ctrl && !key.meta) setFilter((f) => f + input)
      return
    }
    if (input === 'q' || (key.ctrl && input === 'c')) return exit()
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSelected((s) => Math.min(view.length - 1, s + 1))
    else if (input === 's') setSortKey((k) => SORT_KEYS[(SORT_KEYS.indexOf(k) + 1) % SORT_KEYS.length])
    else if (input === '/') { setTyping(true); setFilter('') }
    else if (input === 'k' || input === 'x') {
      const t = view[sel]
      if (t) {
        const force = input === 'x'
        const done = killPid(t.pid, force)
        setStatus(done ? `${force ? 'SIGKILL' : 'SIGTERM'} → :${t.port} (pid ${t.pid})` : `failed: pid ${t.pid}`)
      }
    } else if (input === 'o') {
      const t = view[sel]
      if (t) { openPort(t.port); setStatus(`open http://localhost:${t.port}`) }
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
        <Text color="gray">
          {typing
            ? `filter: ${filter}▏  (enter apply · esc clear)`
            : '↑↓ select · k kill · x force · o open · s sort · / filter · q quit'}
        </Text>
      </Box>
      {status && !typing && <Text color="yellow">  {status}</Text>}
    </Box>
  )
}
