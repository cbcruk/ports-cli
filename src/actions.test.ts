import { fmtKill, isAlive, killPid } from './actions.ts'
import type { Signal } from './core.types.ts'
import { ok, summary } from './test-assert.ts'

// Every signal below is faked through the injected seam: no real processes harmed.
const errno = (code: string) => Object.assign(new Error(code), { code })

// dies after `afterProbes` liveness checks
const mkSignal = (afterProbes: number): Signal => {
  let probes = 0
  return (_pid, sig) => {
    if (sig === 0) {
      if (probes++ >= afterProbes) throw errno('ESRCH')
      return
    }
  }
}

const dies = await killPid(1, false, { waitMs: 500, pollMs: 5, signal: mkSignal(2) })
ok('kill reports actual exit', dies.sent && dies.exited)

const stubborn = await killPid(1, false, { waitMs: 60, pollMs: 10, signal: () => {} })
ok('ignored SIGTERM not reported as success', stubborn.sent && !stubborn.exited)
ok('ignored has reason', stubborn.reason === 'ignored')

const denied = await killPid(1, false, { waitMs: 10, pollMs: 5, signal: () => { throw errno('EPERM') } })
ok('EPERM surfaced', !denied.sent && denied.reason === 'not-permitted')

const gone = await killPid(1, false, { waitMs: 10, pollMs: 5, signal: () => { throw errno('ESRCH') } })
ok('ESRCH surfaced', gone.reason === 'no-such-process')

// EPERM on probe means it exists but isn't ours
ok('isAlive EPERM is alive', isAlive(1, () => { throw errno('EPERM') }))
ok('isAlive ESRCH is dead', !isAlive(1, () => { throw errno('ESRCH') }))
ok('isAlive no throw is alive', isAlive(1, () => {}))

ok('fmtKill exit', fmtKill({ sent: true, exited: true }, 3000, 9, false).includes('exited'))
ok('fmtKill perm', fmtKill(denied, 3000, 9, false).includes('sudo'))
ok('fmtKill ignored suggests -9', fmtKill(stubborn, 3000, 9, false).includes('-9'))
ok('fmtKill sigkill survivor differs', fmtKill(stubborn, 3000, 9, true).includes('survived'))

summary()
