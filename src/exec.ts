/**
 * The real subprocess runner behind every {@link Exec} seam.
 *
 * @module
 */
import { execFile } from 'node:child_process'
import type { Exec } from './core.types.ts'

/**
 * Runs a command and resolves with its stdout.
 *
 * A non-zero exit only rejects when there is no output to salvage: `lsof` exits
 * 1 when *some* of the pids it was handed yield nothing, and what it did print
 * is still valid.
 *
 * @param cmd executable to run
 * @param args arguments passed straight through, unshelled
 * @returns the command's stdout
 */
export const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err)
      else resolve(stdout)
    })
  })
