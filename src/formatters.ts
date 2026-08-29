/**
 * Display formatters for the numeric columns, shared by the TUI and the app
 * window so both render a value the same way.
 *
 * @module
 */

/**
 * Formats a duration in seconds as a compact, largest-unit uptime string,
 * e.g. `45s`, `12m`, `3h07m`, `2d8h`.
 *
 * @param s duration in seconds
 * @returns compact human-readable uptime
 */
export function fmtUptime(s: number): string {
  if (s < 60) return `${s | 0}s`
  if (s < 3600) return `${(s / 60) | 0}m`
  if (s < 86400) return `${(s / 3600) | 0}h${((s % 3600) / 60) | 0}m`
  return `${(s / 86400) | 0}d${((s % 86400) / 3600) | 0}h`
}

/**
 * Formats a %CPU value: `·` when there's no baseline yet (`null`), otherwise
 * one decimal below 10 and whole numbers at or above it.
 *
 * @param c instantaneous %CPU, or `null` on the first sample
 * @returns display string for the CPU column
 */
export function fmtCpu(c: number | null): string {
  return c == null ? '·' : c.toFixed(c >= 10 ? 0 : 1)
}
