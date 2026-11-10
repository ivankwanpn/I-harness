#!/usr/bin/env node
// scripts/test-env.mjs
//
// Makes the test suites self-sufficient: every suite that needs an isolated
// evidence/config directory now gets one per run instead of depending on the
// developer to export `IH_*_EVIDENCE_ROOT` by hand. Explicit values still win,
// so qualification runs keep pointing at their retained evidence.
//
// Usage as an env wrapper:  node scripts/test-env.mjs pnpm -r --no-bail test
// Usage as a module:        import { testEnvironment } from './test-env.mjs'

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import spawn from "cross-spawn"
import { pathToFileURL } from "node:url"

/** Directory-valued variables: tests `mkdtemp(join(process.env.X, ...))`. */
export const EVIDENCE_DIRECTORY_VARS = Object.freeze([
  "IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT",
  "IH_LEGACY_FORK_EVIDENCE_ROOT",
  "IH_BRIDGE_EVIDENCE_ROOT",
  "IH_CANCELLATION_EVIDENCE_ROOT",
  "IH_DELIVERY_EVIDENCE_ROOT",
  "IH_INSTRUCTION_EVIDENCE_ROOT",
  "IH_OWNER_CONTROL_EVIDENCE_ROOT",
  "IH_OWNER_LIFETIME_EVIDENCE_ROOT",
  "IH_RESULT_INTEGRITY_EVIDENCE_ROOT",
  "IH_STRUCTURE_EVIDENCE_ROOT",
  "IH_LONG_GROWTH_EVIDENCE_DIR",
  "IH_CONFIG_DIR",
])

/**
 * Explicit environment extended with a per-run isolated base directory for
 * every evidence directory that is not already set. Optional evidence-output
 * files (`IH_BASELINE_RECEIPTS`, `IH_CODE_CLOSE_EVIDENCE`, ...) are deliberately
 * NOT defaulted: they are opt-in diagnostics, and inventing paths for them
 * would turn "not recording evidence" into "recording it somewhere unexpected".
 */
export function testEnvironment(source = process.env, base = join(tmpdir(), `i-harness-tests-${process.pid}-${Date.now().toString(36)}`)) {
  const env = { ...source }
  const missing = EVIDENCE_DIRECTORY_VARS.filter((name) => !env[name])
  if (missing.length === 0) return env
  mkdirSync(base, { recursive: true })
  for (const name of missing) {
    const directory = join(base, name.toLowerCase())
    mkdirSync(directory, { recursive: true })
    env[name] = directory
  }
  return env
}

function main(argv) {
  if (argv.length === 0) {
    console.error("usage: node scripts/test-env.mjs <command> [args...]")
    return 1
  }
  const [command, ...args] = argv
  const result = spawn.sync(command, args, { env: testEnvironment(), stdio: "inherit", windowsHide: true })
  if (result.error) console.error(result.error.message)
  return result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
