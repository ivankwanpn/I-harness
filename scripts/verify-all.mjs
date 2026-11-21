#!/usr/bin/env node
// scripts/verify-all.mjs
//
// THE WHOLE VERIFICATION, ONE COMMAND, WITH ITS SCOPE CHECKED.
//
// Why it exists: this unit hit the same defect class twice, and both times the
// COMMAND was the problem, not the code —
//   1. block ①'s blast-radius census was scoped to `pnpm -r --no-bail test`, so
//      `e2e/` — a suite with its own vitest config, outside the workspace
//      population — was never in view, and a missed rewrite survived two blocks;
//   2. the recursive run reports a PREFIX when a project fails. Measured twice
//      in this repo's records (both times 62 of 66, with the four missing ones
//      being the transitive dependents of the failed project). A prefix reads
//      EXACTLY like a total — "2675 passed" means nothing unless all 66
//      projects ran, and nothing in the recursive output says which it is.
// A record in a handoff document does not make either unforgettable. A command
// that refuses to report a total it cannot substantiate does.
//
// WHAT IT PROVES: that the seven named steps ran, that every workspace project
// with a `test` script REPORTED a result, and each step's reading is printed
// rather than inferred.
//
// WHAT IT CANNOT PROVE — and a passing run must not be read as covering it:
// NOTHING about whether the tests themselves are meaningful. A green run of a
// suite that asserts nothing looks identical to a green run of one that asserts
// everything. This makes SCOPE visible; quality is not in its reach. (The same
// limit the reachability instrument states for itself, for the same reason: the
// failure mode this repo keeps shipping is a check that reports a clean result
// about a question it never asked.)
//
// Usage: pnpm verify:all
// CI can run one named suite with --suite <name>, or e2e and reachability
// with --integration alongside the existing typecheck and gateway jobs.

import spawn from "cross-spawn"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testEnvironment } from "./test-env.mjs"

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
// The ESC is written as an escape sequence, never as a raw control byte: a
// literal ESC in a source file is the same class of hazard as a stray CR.
const ANSI = /\u001B\[[0-9;]*m/g
const strip = (s) => s.replace(ANSI, "")

function rule(title) {
  const bar = "─".repeat(Math.max(0, 72 - title.length))
  console.log(`\n── ${title} ${bar}`)
}

/** The population `pnpm -r` walks: workspace dirs holding a package.json with a
 *  `test` script. Globs are read from pnpm-workspace.yaml so this cannot drift
 *  from the tree the way a literal 66 would; a glob shape it cannot expand is
 *  REPORTED rather than silently undercounted. */
function expectedPopulation() {
  const raw = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8")
  const globs = [...raw.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1].trim())
  const dirs = []
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = join(ROOT, glob.slice(0, -2))
      if (!existsSync(parent)) continue
      for (const name of readdirSync(parent)) {
        const pkg = join(parent, name, "package.json")
        if (!existsSync(pkg)) continue
        try {
          if (JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) dirs.push(`${glob.slice(0, -2)}/${name}`)
        } catch { /* an unreadable package.json is not a population entry */ }
      }
    } else {
      console.log(`   ⚠ workspace glob "${glob}" is not of the form <dir>/* — this count may be SHORT.`)
    }
  }
  return [...new Set(dirs)].sort()
}

// The three longest measured packages each get an independent Windows runner.
// Every current and future package with a test script has exactly one group.
function suitePlan(expected) {
  const anchors = {
    gateway: "packages/desktop-gateway",
    executor: "packages/session-executor",
    "context-output": "packages/context-output",
  }
  const suites = Object.fromEntries(Object.entries(anchors).map(([name, path]) =>
    [name, expected.filter(dir => dir === path)]))
  suites.workspace = expected.filter(dir => !Object.values(anchors).includes(dir))
  return suites
}

const expected = expectedPopulation()
const suites = suitePlan(expected)
const args = process.argv.slice(2)
let suiteGroup
let integrationOnly = false
if (args.length === 1 && args[0] === "--list-suites") {
  console.log(JSON.stringify(suites, null, 2))
  process.exit(0)
} else if (args.length === 1 && args[0] === "--integration") {
  integrationOnly = true
} else if (args.length === 2 && args[0] === "--suite" && Object.hasOwn(suites, args[1])) {
  suiteGroup = args[1]
} else if (args.length > 0) {
  console.error("Usage: node scripts/verify-all.mjs [--suite <gateway|executor|context-output|workspace> | --integration | --list-suites]")
  process.exit(1)
}

// Isolated evidence/config directories for every suite (scripts/test-env.mjs).
const TEST_ENV = testEnvironment()

/** Runs a step, streaming its output while capturing it (a step that takes
 *  minutes must not look like a hang). Returns { code, text }. */
function run(cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true, env: TEST_ENV })
    let text = ""
    const sink = (chunk) => {
      const s = chunk.toString()
      text += s
      process.stdout.write(s)
    }
    child.stdout.on("data", sink)
    child.stderr.on("data", sink)
    child.once("error", (error) => sink(`Failed to start ${cmd}: ${error.message}\n`))
    child.on("close", (code) => done({ code: code ?? 1, text: strip(text) }))
  })
}

const readings = {}
let failed = false

if (!integrationOnly) {
  rule("prepare · test command argument handling")
  const runnerCheck = await run("node", ["--test", "scripts/test-env.test.mjs"])
  if (runnerCheck.code !== 0) {
    console.error("Test command preparation failed; no suite result can be claimed.")
    process.exit(1)
  }

  const projects = suiteGroup ? suites[suiteGroup] : expected
  if (!projects.length) {
    console.error("Verification selected no workspace test projects.")
    process.exit(1)
  }

  // Fresh checkouts need the ignored worker payload before Desktop tests.
  if (projects.includes("packages/desktop")) {
    rule("prepare · Desktop attachment reader")
    const preparation = await run("node", ["packages/desktop/scripts/build-attachment-reader.mjs"])
    if (preparation.code !== 0) {
      console.error("Verification preparation failed; no test result can be claimed.")
      process.exit(1)
    }
  }

  rule(suiteGroup ? `workspace suite · ${suiteGroup}` : "1/7 · workspace suite")
  // Keep native integration fixtures serial within each runner. Independent
  // projects still report if an earlier package fails.
  const filters = suiteGroup ? projects.flatMap(dir => ["--filter", `./${dir}`]) : []
  const suite = await run("pnpm", ["-r", ...filters, "--no-bail", "--no-sort", "--stream", "--workspace-concurrency=1", "test", "--maxWorkers=2", "--minWorkers=1", "--testTimeout=120000", "--hookTimeout=120000"])
  const reportedDirs = [...new Set([...suite.text.matchAll(/^(\S+) test:\s+Test Files /gm)].map(m => m[1]))].sort()
  const failedProjects = [...suite.text.matchAll(/^(\S+) test: Failed$/gm)].map(m => m[1]).sort()
  let passed = 0
  let skipped = 0
  let failedTests = 0
  for (const m of suite.text.matchAll(/^\S+ test:\s+Tests\s+(.*)$/gm)) {
    const words = m[1].split(/\s+/)
    for (let i = 0; i < words.length; i += 1) {
      if (words[i + 1] === "passed") passed += Number(words[i])
      if (words[i + 1] === "skipped") skipped += Number(words[i])
      if (words[i + 1] === "failed") failedTests += Number(words[i])
    }
  }
  readings.suite = { code: suite.code, passed, skipped, failed: failedTests }
  readings.population = { expected: projects.length, reported: reportedDirs.length }
  console.log(`\n   reading: exit ${suite.code} · ${passed} passed | ${skipped} skipped | ${failedTests} failed`)
  console.log(`   reading: ${reportedDirs.length} of ${projects.length} projects reported${failedProjects.length > 0 ? ` · FAILED: ${failedProjects.join(", ")}` : ""}`)
  failed = suite.code !== 0 || failedProjects.length > 0 || failedTests > 0

  rule(suiteGroup ? "suite population" : "2/7 · population")
  const missing = projects.filter(dir => !reportedDirs.includes(dir))
  const unexpected = reportedDirs.filter(dir => !projects.includes(dir))
  if (missing.length || unexpected.length) {
    console.log("   ✗ Suite reports differ from the planned workspace projects.")
    if (missing.length) console.log(`     never reported: ${missing.join(", ")}`)
    if (unexpected.length) console.log(`     unexpected: ${unexpected.join(", ")}`)
    failed = true
  } else {
    console.log(`   ✓ all ${projects.length} planned projects reported`)
  }

  if (suiteGroup) {
    rule(failed ? "WORKSPACE SUITE FAILED" : "WORKSPACE SUITE PASSED")
    process.exit(failed ? 1 : 0)
  }

  rule("3/7 · pnpm typecheck")
  const types = await run("pnpm", ["typecheck"])
  readings.typecheck = { code: types.code }
  console.log(`\n   reading: exit ${types.code}`)
  if (types.code !== 0) failed = true
}

// ── 4/7 · the suite the recursive walk does not reach ────────────────────────
rule("4/7 · pnpm e2e")
const e2e = await run("pnpm", ["e2e", "--maxWorkers=2", "--minWorkers=1"])
const e2eFiles = [...e2e.text.matchAll(/✓ (e2e\/[\w.-]+)\s+\((\d+) tests?\)/g)].map((m) => `${m[1]} ${m[2]}`)
readings.e2e = { code: e2e.code, files: e2eFiles.length }
console.log(`\n   reading: exit ${e2e.code} · ${e2eFiles.length} files · ${e2eFiles.join(" · ")}`)
if (e2e.code !== 0) failed = true

// ── 5/7 · the reachability gate ──────────────────────────────────────────────
rule("5/7 · node scripts/audit/check-reachability.mjs --gate")
const gate = await run("node", ["scripts/audit/check-reachability.mjs", "--gate"])
const gateLine = gate.text.match(/^reachability: (.*)$/m)
readings.gate = { code: gate.code, line: gateLine?.[1] ?? "(no reading line)" }
console.log(`\n   reading: exit ${gate.code} · ${readings.gate.line}`)
if (gate.code !== 0) failed = true

if (integrationOnly) {
  rule(failed ? "INTEGRATION CHECKS FAILED" : "INTEGRATION CHECKS PASSED")
  process.exit(failed ? 1 : 0)
}

rule("6/7 · package boundaries")
const boundaries = await run("node", ["scripts/audit/check-package-boundaries.mjs", "--gate"])
readings.boundaries = { code: boundaries.code }
if (boundaries.code !== 0) failed = true

rule("7/7 · compiled gateway and native runner")
const artifact = await run("pnpm", ["verify:gateway"])
readings.artifact = { code: artifact.code }
if (artifact.code !== 0) failed = true

// ── the summary ──────────────────────────────────────────────────────────────
rule(failed ? "VERIFY:ALL FAILED" : "VERIFY:ALL PASSED")
console.log(`   suite      : exit ${readings.suite.code} · ${readings.suite.passed} passed | ${readings.suite.skipped} skipped | ${readings.suite.failed} failed`)
console.log(`   population : ${readings.population.reported} of ${readings.population.expected} projects reported`)
console.log(`   typecheck  : exit ${readings.typecheck.code}`)
console.log(`   e2e        : exit ${readings.e2e.code} · ${readings.e2e.files} files`)
console.log(`   gate       : exit ${readings.gate.code} · ${readings.gate.line}`)
console.log(`   boundaries : exit ${readings.boundaries.code}`)
console.log(`   artifact   : exit ${readings.artifact.code}`)
console.log("\n   SCOPE IS CHECKED HERE; MEANING IS NOT. A green run of a suite that asserts nothing")
console.log("   is indistinguishable from this one. This command can only tell you how much ran.")
process.exit(failed ? 1 : 0)
