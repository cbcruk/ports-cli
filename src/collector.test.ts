import { createCollector } from './collector.ts'
import type { Exec } from './core.types.ts'
import { ok, summary } from './test-assert.ts'

// CPU is a delta, so it is null on the first tick and a number on the second.
// The exec seam replays canned lsof/ps output; the sleep between ticks is real,
// because the delta divides by elapsed wall time.
const mkExec = (cpu1: string, cpu2: string): Exec => {
  let tick = 0
  return async (cmd, args) => {
    if (cmd === 'lsof' && args.includes('-sTCP:LISTEN'))
      return 'p52341\ncnode\nn127.0.0.1:55725\nn127.0.0.1:3000\nn[::1]:3000\n'
    if (cmd === 'lsof') return 'p52341\nfcwd\nn/Users/e/web\n'
    tick++
    return `52341  185600  05:23:11  ${tick === 1 ? cpu1 : cpu2} /usr/local/bin/node next dev`
  }
}

const col = createCollector(mkExec('0:04.00', '0:04.50'))
const r1 = await col.collect()
// one row per pid, not per port; primary port is the lowest
ok('tick1 one row per pid', r1.length === 1)
ok('tick1 primary port', r1[0].port === 3000)
ok('tick1 all ports', r1[0].ports.join() === '3000,55725')
ok('tick1 cpu null', r1[0].cpu === null)
ok('tick1 framework', r1[0].framework === 'Next.js')
ok('tick1 project', r1[0].project === 'web')
ok('tick1 mem MB', Math.abs(r1[0].memMB - 181.25) < 0.1)

await new Promise((r) => setTimeout(r, 1000))
const r2 = await col.collect()
// ~0.5 CPU-sec over ~1 wall-sec ⇒ ~50%
ok('tick2 cpu number', typeof r2[0].cpu === 'number')
ok('tick2 cpu plausible', r2[0].cpu! > 20 && r2[0].cpu! < 90)

summary()
