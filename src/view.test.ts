import assert from 'node:assert'
import type { Row } from './core.ts'
import { sortRows, filterRows, filterSystem, rowCells, headerCells, formatLine, COLS } from './view.ts'

let pass = 0
const ok = (n: string, c: boolean) => { assert(c, n); pass++ }

const mk = (o: Partial<Row>): Row => ({
  port: 3000, pid: 1, command: 'node', framework: 'Node', project: 'p',
  cpu: 0, memMB: 0, uptimeSecs: 0, ...o,
})

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
const sysRows = [mk({ port: 3000 }), mk({ port: 7000, command: '/Applications/Spotify.app/Contents/MacOS/Spotify' })]
ok('system hidden by default', filterSystem(sysRows, false).map((r) => r.port).join() === '3000')
ok('--all keeps everything', filterSystem(sysRows, true).length === 2)

console.log(`\n✓ ${pass} assertions passed`)
