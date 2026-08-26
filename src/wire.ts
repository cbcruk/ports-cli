/**
 * The row shape that crosses into the browser UI.
 *
 * Kept apart from `core.ts` (which owns the subprocesses) and from
 * `web-entry.ts` (which owns the window) so the shape can be unit-tested
 * without a Chrome anywhere in sight.
 */
import { fmtCpu, fmtUptime, isEphemeralOnly, isSystemProcess, type Row } from './core.ts'
import { fmtPorts } from './view.ts'

/**
 * A row as handed to the page: the raw {@link Row} (so the client can sort on
 * real numbers) plus a `noise` flag and preformatted display strings, so the
 * page never has to reimplement the formatters in `core.ts`/`view.ts`.
 */
export type WireRow = Row & {
  noise: boolean
  display: { ports: string; cpu: string; mem: string; up: string }
}

/**
 * Annotates a row for the page: marks system/GUI/ephemeral listeners as noise
 * (the client toggles them, so no round trip) and precomputes display strings.
 *
 * @param r a collected row
 * @returns the row plus its `noise` flag and display strings
 */
export function toWire(r: Row): WireRow {
  return {
    ...r,
    noise: isSystemProcess(r.command) || isEphemeralOnly(r.ports),
    display: {
      ports: fmtPorts(r),
      cpu: fmtCpu(r.cpu),
      mem: r.memMB.toFixed(0),
      up: fmtUptime(r.uptimeSecs),
    },
  }
}
