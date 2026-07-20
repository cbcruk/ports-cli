import assert from 'node:assert'
import type { Row } from './core.ts'
import { sortRows, filterRows, filterSystem, fmtPorts, resolveSelection, rowCells, headerCells, formatLine, COLS } from './view.ts'

let pass = 0
const ok = (n: string, c: boolean) => { assert(c, n); pass++ }

const mk = (o: Partial<Row>): Row => {
  const r = {
    port: 3000, pid: 1, command: 'node', framework: 'Node', project: 'p',
    cpu: 0, memMB: 0, uptimeSecs: 0, ...o,
  }
  return { ...r, ports: o.ports ?? [r.port] }
}

const rows = [
  mk({ port: 8000, cpu: 5, memMB: 40, uptimeSecs: 100, framework: 'Python', project: 'api' }),
  mk({ port: 3000, cpu: 80, memMB: 180, uptimeSecs: 9000, framework: 'Next.js', project: 'web' }),
  mk({ port: 5173, cpu: null, memMB: 90, uptimeSecs: 50, framework: 'Vite', project: 'dash' }),
]

ok('sort port', sortRows(rows, 'port').map((r) => r.port).join() === '3000,5173,8000')
ok('sort cpu desc, null last', sortRows(rows, 'cpu').map((r) => r.port).join() === '3000,8000,5173')
ok('sort mem desc', sortRows(rows, 'mem').map((r) => r.port).join() === '3000,5173,8000')
ok('sort uptime desc', sortRows(rows, 'uptime').map((r) => r.port).join() === '3000,8000,5173')

ok('filter by framework', filterRows(rows, 'vite').length === 1)
ok('filter by project', filterRows(rows, 'web')[0].port === 3000)
ok('filter by port substr', filterRows(rows, '000').map((r) => r.port).sort().join() === '3000,8000')
ok('empty filter passthrough', filterRows(rows, '').length === 3)

const cells = rowCells(rows[1])
ok('port cell width', cells[0].length === COLS.port)
ok('framework cell width', cells[1].length === COLS.fw)
ok('cpu right-aligned', cells[4].endsWith('80'))
ok('null cpu renders dot', rowCells(rows[2])[4].trim() === '·')
ok('long command untruncated', rowCells(mk({ command: 'x'.repeat(200) }))[7].length === 200)
ok('header cols', headerCells()[0].startsWith('PORT'))

// truncation with ellipsis
ok('project truncates', rowCells(mk({ project: 'a-really-long-project-name' }))[2].endsWith('…'))

// ── formatLine ── (GUI argv runs to thousands of chars; must not wrap the terminal)
const long = formatLine(rowCells(mk({ command: 'x'.repeat(3000) })), 100)
ok('line clamped to width', long.length === 100)
ok('line marks truncation', long.endsWith('…'))
ok('short line untouched', formatLine(['a', 'b'], 80) === 'a b')

// ── filterSystem ──
const sysRows = [
  mk({ port: 3000 }),
  mk({ port: 7000, command: '/Applications/Spotify.app/Contents/MacOS/Spotify' }),
  mk({ port: 55730, ports: [55730, 57694] }), // workerd control sockets only
]
ok('system hidden by default', filterSystem(sysRows, false).map((r) => r.port).join() === '3000')
ok('--all keeps everything', filterSystem(sysRows, true).length === 3)

// ── fmtPorts ── (one row per pid, extra ports summarised)
ok('single port plain', fmtPorts(mk({ port: 3000 })) === '3000')
ok('multi port suffix', fmtPorts(mk({ port: 9229, ports: [9229, 55725, 55727] })) === '9229 +2')
ok('port cell width', rowCells(mk({ port: 9229, ports: [9229, 1, 2] }))[0].length === COLS.port)
ok('filter matches secondary port', filterRows([mk({ port: 9229, ports: [9229, 55725] })], '55725').length === 1)

// ── resolveSelection ── (the bug: index-based cursor drifted onto another process)
const a = mk({ port: 3000, pid: 10 })
const b = mk({ port: 5173, pid: 20 })
const c = mk({ port: 8000, pid: 30 })

ok('finds pid', resolveSelection([a, b, c], 20, 0) === 1)
// same list re-sorted by a volatile key — cursor must track the process, not the slot
ok('survives reorder', resolveSelection([c, b, a], 20, 0) === 1)
ok('survives reorder to a new slot', resolveSelection([b, c, a], 20, 2) === 0)
// a row above the cursor disappears; pid still wins over the stale index
ok('survives removal above', resolveSelection([b, c], 30, 2) === 1)
// the selected process itself is gone — hold the slot, do not jump to the top
ok('dead pid holds slot', resolveSelection([a, b], 99, 1) === 1)
ok('dead pid clamps to end', resolveSelection([a], 99, 5) === 0)
ok('empty list is 0', resolveSelection([], 10, 3) === 0)
ok('null pid uses lastIdx', resolveSelection([a, b, c], null, 2) === 2)

console.log(`\n✓ ${pass} assertions passed`)
