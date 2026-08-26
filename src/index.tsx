#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { openSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import { App } from './tui.tsx'

// Replaced at build time via esbuild/bun `--define`; falls back to 'dev' under tsx.
declare const __VERSION__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'

/**
 * Opens the controlling terminal as a raw-mode-capable input stream.
 *
 * `process.stdin` is not a TTY when the process was launched from a pipeline,
 * with stdin redirected, or by a wrapper that replaces it — even inside a real
 * terminal. Borrowing `/dev/tty` (the same trick fzf and vim use) keeps the
 * keys working instead of refusing to start.
 *
 * @returns a TTY read stream, or `null` when there is no controlling terminal
 */
function openControllingTty(): NodeJS.ReadStream | null {
  try {
    return new ReadStream(openSync('/dev/tty', 'r')) as unknown as NodeJS.ReadStream
  } catch {
    return null
  }
}

const argv = process.argv.slice(2)
const showAll = argv.includes('-a') || argv.includes('--all')

if (argv.includes('-v') || argv.includes('--version')) {
  console.log(VERSION)
} else if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ports — live view of localhost dev servers

usage: ports [-a | --all]

  -a, --all      include OS daemons, GUI apps, ephemeral-only listeners
  -v, --version  print version
  -h, --help     print this help

keys: ↑↓ select · k kill · x force · o open · s sort · / filter · q quit

For the same thing in a desktop window, grab a standalone binary from the
releases page — it needs no node, and opens a window with no flags.`)
} else if (!process.stdout.isTTY) {
  // Nothing to draw on — the only case worth refusing outright.
  console.error('ports needs an interactive terminal to run (stdout is not a TTY)')
  process.exitCode = 1
} else {
  const stdin = process.stdin.isTTY ? process.stdin : openControllingTty()
  if (!stdin) {
    console.error('ports needs an interactive terminal to run (no readable /dev/tty)')
    process.exitCode = 1
  } else {
    render(<App showAll={showAll} />, { stdin })
  }
}
