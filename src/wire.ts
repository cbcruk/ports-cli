/**
 * The row shape that crosses into the browser UI.
 *
 * Kept apart from the collector (which owns the subprocesses) and from
 * `web-entry.ts` (which owns the window) so the shape can be unit-tested
 * without a Chrome anywhere in sight.
 *
 * @example Prepare a snapshot for the page
 * ```ts
 * import { createCollector } from './collector.ts'
 * import { toWire } from './wire.ts'
 *
 * const rows = (await createCollector().collect()).map(toWire)
 * ```
 *
 * @module
 */
import type { Row } from './core.types.ts'
import { fmtCpu, fmtUptime } from './formatters.ts'
import { isEphemeralOnly, isSystemProcess } from './parsers.ts'
import { fmtPorts } from './view.ts'

/**
 * A row as handed to the page: the raw {@link Row} (so the client can sort on
 * real numbers) plus a `noise` flag and preformatted display strings, so the
 * page never has to reimplement the formatters in `formatters.ts`/`view.ts`.
 */
export type WireRow = Row & {
  /** `true` for a system/GUI or ephemeral-only listener, which the client hides by default. */
  noise: boolean
  /** Cells already run through the shared formatters, ready to drop into the table. */
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
