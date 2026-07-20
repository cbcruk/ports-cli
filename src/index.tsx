#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { createCollector, killPid, openPort } from './core.ts'
import { sortRows, filterSystem, rowCells, headerCells, formatLine } from './view.ts'
import { App } from './tui.tsx'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SAMPLE_MS = 600

async function snapshot(json: boolean, showAll: boolean) {
  const { collect } = createCollector()
  let rows = await collect()
  if (rows.length) {
    // second sample so the CPU column is a live delta, not null
    await sleep(SAMPLE_MS)
    rows = await collect()
  }
  rows = filterSystem(rows, showAll)

  if (json) return void console.log(JSON.stringify(rows, null, 2))
  if (!rows.length) return void console.log('no dev servers listening on localhost')

  const width = process.stdout.columns ?? 120
  console.log(formatLine(headerCells(), width))
  for (const r of sortRows(rows, 'port')) console.log(formatLine(rowCells(r), width))
}

async function killPorts(ports: number[], force: boolean) {
  if (!ports.length) {
    console.error('usage: ports kill <port>... [-9]')
    process.exitCode = 1
    return
  }
  const rows = await createCollector().collect()
  for (const p of ports) {
    const hit = rows.find((r) => r.ports.includes(p))
    if (!hit) { console.log(`:${p} not found`); continue }
    const ok = killPid(hit.pid, force)
    console.log(ok ? `${force ? 'SIGKILL' : 'SIGTERM'} → :${p} (pid ${hit.pid})` : `failed :${p}`)
  }
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const showAll = argv.includes('-a') || argv.includes('--all')

if (cmd === 'kill') {
  const ports = argv.slice(1).filter((a) => /^\d+$/.test(a)).map(Number)
  await killPorts(ports, argv.includes('-9') || argv.includes('--force'))
} else if (cmd === 'open') {
  const port = argv[1]
  if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) {
    console.error('usage: ports open <port>')
    process.exitCode = 1
  } else {
    openPort(Number(port))
  }
} else if (cmd === '-w' || cmd === '--watch') {
  if (!process.stdout.isTTY) {
    console.error('watch needs a TTY — snapshot instead:\n')
    await snapshot(false, showAll)
  } else {
    render(<App showAll={showAll} />)
  }
} else {
  await snapshot(argv.includes('--json'), showAll)
}
