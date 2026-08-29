/**
 * What the UIs do *to* a listener: signal it, and open it in a browser.
 *
 * Every action reports what actually happened rather than what was attempted,
 * because a delivered signal is not the same as a dead process.
 *
 * @module
 */
import type { Exec, KillOutcome, Signal } from './core.types.ts'
import { defaultExec } from './exec.ts'

const defaultSignal: Signal = (pid, sig) => void process.kill(pid, sig)

/**
 * Reports whether a pid is still alive by sending it signal `0` (a
 * permission/existence probe that delivers nothing).
 *
 * `EPERM` means the process exists but isn't ours — so it counts as alive;
 * `ESRCH` means it's gone.
 *
 * @param pid process id to probe
 * @param signal signal sender (injectable for tests)
 * @returns `true` if the process still exists
 */
export function isAlive(pid: number, signal: Signal = defaultSignal): boolean {
  try {
    signal(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const errReason = (e: unknown): KillOutcome['reason'] => {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'EPERM') return 'not-permitted'
  if (code === 'ESRCH') return 'no-such-process'
  return 'unknown'
}

/**
 * Signals a process and waits until it has actually exited.
 *
 * Sending a signal only means it was delivered — a SIGTERM handler may ignore
 * it — so this polls with signal `0` until the pid is gone or `waitMs`
 * elapses, letting callers report the truth (exited vs. ignored vs. EPERM).
 *
 * @param pid process id to kill
 * @param force send `SIGKILL` instead of `SIGTERM`
 * @param opts `waitMs` total budget, `pollMs` poll interval, injectable `signal`
 * @returns the resolved {@link KillOutcome}
 *
 * @example Escalate to SIGKILL only when SIGTERM is ignored
 * ```ts
 * import { killPid, fmtKill } from './actions.ts'
 * import { createCollector } from './collector.ts'
 *
 * const [row] = await createCollector().collect()
 * let outcome = await killPid(row.pid)
 * if (outcome.reason === 'ignored') outcome = await killPid(row.pid, true)
 * console.log(fmtKill(outcome, row.port, row.pid, true))
 * ```
 */
export async function killPid(
  pid: number,
  force = false,
  opts: { waitMs?: number; pollMs?: number; signal?: Signal } = {},
): Promise<KillOutcome> {
  const { waitMs = 2000, pollMs = 50, signal = defaultSignal } = opts
  try {
    signal(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch (e) {
    return { sent: false, exited: false, reason: errReason(e) }
  }
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    if (!isAlive(pid, signal)) return { sent: true, exited: true }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  if (!isAlive(pid, signal)) return { sent: true, exited: true }
  return { sent: true, exited: false, reason: 'ignored' }
}

/**
 * Renders a {@link KillOutcome} as a human-readable status line, distinguishing
 * success from *not yours* (EPERM), *already gone* (ESRCH), and *ignored*.
 *
 * @param o outcome returned by {@link killPid}
 * @param port port shown in the message
 * @param pid process id shown in the message
 * @param force whether the attempt used `SIGKILL`
 * @returns a one-line summary suitable for display
 */
export function fmtKill(o: KillOutcome, port: number, pid: number, force: boolean): string {
  if (o.exited) return `${force ? 'SIGKILL' : 'SIGTERM'} → :${port} (pid ${pid}) exited`
  switch (o.reason) {
    case 'not-permitted': return `:${port} (pid ${pid}) not yours — try sudo`
    case 'no-such-process': return `:${port} already gone`
    case 'ignored':
      return force
        ? `:${port} (pid ${pid}) survived SIGKILL — stuck in the kernel`
        : `:${port} (pid ${pid}) ignored SIGTERM — force with -9`
    default: return `:${port} (pid ${pid}) failed`
  }
}

/**
 * Opens a URL in the default browser via the platform opener (`open` on macOS,
 * `xdg-open` elsewhere). Fire-and-forget: failures are swallowed so a missing
 * opener can't crash the UI.
 *
 * @param url the URL to open
 * @param exec command runner (injectable for tests)
 */
export function openUrl(url: string, exec: Exec = defaultExec): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  void exec(opener, [url]).catch(() => {})
}

/**
 * Opens `http://localhost:<port>` in the default browser.
 *
 * @param port localhost port to open
 * @param exec command runner (injectable for tests)
 */
export function openPort(port: number, exec: Exec = defaultExec): void {
  openUrl(`http://localhost:${port}`, exec)
}
