/**
 * The shapes the whole program agrees on.
 *
 * Holds the collected-listener row plus the two injection seams — `Exec` and
 * `Signal` — that let the subprocess-driven modules be tested against canned
 * output instead of real `lsof`, `ps`, and signals.
 *
 * @module
 */

/**
 * One localhost listener, collapsed to a single process.
 *
 * A process listening on several ports yields one row rather than several: the
 * lowest port is the one you would browse to, and the rest stay in
 * {@link Row.ports}.
 */
export type Row = {
  /** Primary port — the lowest one the process listens on. */
  port: number
  /** Every port this pid listens on, ascending. */
  ports: number[]
  /** Process id of the listener. */
  pid: number
  /** Full argv / command string, as reported by `ps`. */
  command: string
  /** Framework name from `detectFramework`, or `'—'` when unrecognised. */
  framework: string
  /** Basename of the process's working directory, or `''` when unknown. */
  project: string
  /** Instantaneous %CPU, or `null` on the first sample — there is no baseline to diff against yet. */
  cpu: number | null
  /** Resident set size in MB. */
  memMB: number
  /** Seconds elapsed since the process started. */
  uptimeSecs: number
}

/**
 * Runs an external command and resolves with its stdout.
 *
 * Injectable so the collector can be tested against canned output instead of
 * spawning real `lsof`/`ps` subprocesses.
 */
export type Exec = (cmd: string, args: string[]) => Promise<string>

/**
 * Sends a signal to a pid, or probes it with signal `0`.
 *
 * Injectable so the kill wait loop can be tested without real processes.
 */
export type Signal = (pid: number, sig: NodeJS.Signals | 0) => void

/**
 * The result of a `killPid` attempt.
 *
 * Delivering a signal and the process actually dying are separate facts, so
 * they are separate fields — a SIGTERM handler may swallow the signal.
 */
export type KillOutcome = {
  /** Whether the signal was delivered at all. */
  sent: boolean
  /** Whether the process was confirmed gone before the wait budget ran out. */
  exited: boolean
  /** Why it did not exit: `EPERM`, `ESRCH`, a swallowed signal, or an unclassified error. */
  reason?: 'not-permitted' | 'no-such-process' | 'ignored' | 'unknown'
}

/** A stateful snapshotter of localhost listeners, built by `createCollector`. */
export type Collector = {
  /** Takes one snapshot, reusing the previous call's CPU sample and cwd cache. */
  collect: () => Promise<Row[]>
}
