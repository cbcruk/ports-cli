/**
 * The assertion counter the test scripts share.
 *
 * Each script runs as its own process (`bun src/<name>.test.ts`), so the
 * module-level tally belongs to exactly one run and never needs resetting.
 *
 * @module
 */
import assert from 'node:assert'

let passed = 0

/**
 * Asserts a condition and counts it toward the run's total.
 *
 * @param name what the assertion proves; surfaces as the failure message
 * @param cond the condition under test
 */
export function ok(name: string, cond: boolean): void {
  assert(cond, name)
  passed++
}

/** Prints how many assertions passed. Call once, at the end of a script. */
export function summary(): void {
  console.log(`\n✓ ${passed} assertions passed`)
}
