import { fmtCpu, fmtUptime } from './formatters.ts'
import { ok, summary } from './test-assert.ts'

ok('uptime s', fmtUptime(45) === '45s')
ok('uptime m', fmtUptime(600) === '10m')
ok('uptime h', fmtUptime(19391) === '5h23m')

ok('cpu null is a dot', fmtCpu(null) === '·')
ok('cpu one decimal below 10', fmtCpu(1.53) === '1.5')
ok('cpu whole at 10 and up', fmtCpu(82.4) === '82')

summary()
