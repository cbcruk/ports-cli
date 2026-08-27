import assert from 'node:assert'
import { toWire } from './wire.ts'
import type { Row } from './core.ts'

let pass = 0
const ok = (n: string, c: boolean) => { assert(c, n); pass++ }

const mk = (o: Partial<Row>): Row => {
  const r = {
    port: 3000, pid: 4242, command: 'node next dev', framework: 'Next.js',
    project: 'web', cpu: 1.5, memMB: 180, uptimeSecs: 19391, ...o,
  }
  return { ...r, ports: o.ports ?? [r.port] }
}

// ── toWire ── (noise flag + display strings, so the page reuses core's formatters)
const plain = toWire(mk({}))
ok('wire keeps raw fields', plain.port === 3000 && plain.memMB === 180)
ok('wire display ports', plain.display.ports === '3000')
ok('wire display up', plain.display.up === '5h23m')
ok('wire display cpu', plain.display.cpu === '1.5')
ok('wire display mem is whole', plain.display.mem === '180')
ok('dev server is not noise', plain.noise === false)
ok('system process is noise', toWire(mk({ command: '/Applications/Spotify.app/Contents/MacOS/Spotify' })).noise)
ok('ephemeral-only is noise', toWire(mk({ port: 55725, ports: [55725, 57694] })).noise)
ok('multi-port display', toWire(mk({ port: 9229, ports: [9229, 55725, 55727] })).display.ports === '9229 +2')
ok('null cpu display', toWire(mk({ cpu: null })).display.cpu === '·')

console.log(`\n✓ ${pass} assertions passed`)
