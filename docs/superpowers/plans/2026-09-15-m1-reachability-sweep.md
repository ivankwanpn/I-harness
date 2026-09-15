# M1 Phase A — Reachability Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a re-runnable tool that finds things this repo *declares* but never uses on a production path, run it, and commit the measured baseline that M1 Phase B and milestone M2 both depend on.

**Architecture:** One plain `.mjs` script under `scripts/audit/`, following the existing convention there (not in the pnpm workspace, no vitest, no typecheck). It indexes the TypeScript tree once, then runs five independent scanners over that index, each answering one shape of "declared but unwired". Correctness is proven by an inline self-test that synthesises a tiny tree in `os.tmpdir()` and asserts on the findings — the precedent is `scripts/audit/compare-fork-branches.mjs:57`, which prints `stripLine self-test: 4/4 ok`.

**Tech Stack:** Node ESM (`.mjs`), `node:fs`, `node:path`, `node:os`. No new dependencies — the repo's zero-external-dependency discipline applies.

**Spec:** `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` — read §1.1 (the re-measure rule this plan exists to serve), §3.M1, and §3.M2 (which consumes this tool's baseline).

## Global Constraints

- **This plan is Phase A only — measure, do not fix.** The fix tasks are enumerated *from* the baseline this plan produces, and get their own plan. Do not fix anything here; do not edit any file under `packages/` or `apps/`.
- **Scripts are not in the workspace.** `pnpm -r test` and `pnpm -r typecheck` do not cover `scripts/`. There is no test framework here; the self-test is part of the script.
- **No new dependencies.** `package.json` devDependencies are `typescript, vitest, @types/node, tsx, esbuild`. Add nothing.
- **Run the gates before and after.** `pnpm -r typecheck` (expect exit 0) and `node scripts/audit/check-thresholds.mjs` (expect `ALL THRESHOLDS PASS`). This plan must not move either.
- **Line endings:** every file under `docs/` and `scripts/` is CRLF in the worktree (the index is LF via `core.autocrlf=true`). Check with `git ls-files --eol <file>` before editing, and `git diff --check` before committing.
- **Push to `m64` only.** Merge timing into `main` is the human's decision.
- **The tool is a heuristic, and must say so.** It proves "nothing in the production tree mentions this name" — not "this is dead". False positives are expected and are handled by the allowlist in Task 5, not by making the heuristic cleverer.

---

## File Structure

- **Create** `scripts/audit/check-reachability.mjs` — the whole tool. One file, following the sibling scripts' shape (header comment stating what it checks and why, `ROOT` from `process.argv[1]`, human-readable output by default, `--json` for machines).
- **Create** `docs/audit/2026-09-15-reachability-baseline.md` — the measured table, the allowlist, and the machine fingerprint. This is the artefact M1 Phase B and M2 consume.
- **Not modified:** anything under `packages/`, `apps/`, or any existing script.

Each scanner is a separate function with a single responsibility, so a reviewer can reject one class while approving its neighbour.

---

### Task 1: The tool's skeleton, the file index, and the self-test harness

**Files:**
- Create: `scripts/audit/check-reachability.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `collectTs(dir) -> string[]`; `indexTree(root) -> File[]` where `File = { abs, rel, test, text }` and `rel` uses forward slashes; `isTestPath(abs) -> boolean`; `runSelfTest() -> {ok, total}`; the CLI surface `--root <dir>`, `--json`, `--self-test`.

- [ ] **Step 1: Write the self-test first, against the fixture it will build**

Create `scripts/audit/check-reachability.mjs` containing only the fixture builder, the harness, and an empty `SCANNERS` list:

```js
#!/usr/bin/env node
// scripts/audit/check-reachability.mjs
//
// Finds what this repo DECLARES but never uses on a production path.
//
// Why it exists: three shipped features were once declared, tested and never
// wired -- the fs guard never consulted the sandbox mode, the shipped hosts never
// passed `compact`, and the TUI composes no sandbox at all. Each was found by a
// human reading code, months apart. This makes that search repeatable.
//
// What it CAN prove: nothing in the non-test tree mentions this name / constructs
// this event / reads this flag.
// What it CANNOT prove: that a declaration which IS mentioned is wired correctly,
// or that a declaration is dead rather than public API. Both are judgements, and
// they belong in the allowlist, not in a cleverer regex.
//
// Usage:
//   node scripts/audit/check-reachability.mjs                 # human table
//   node scripts/audit/check-reachability.mjs --json          # machine readable
//   node scripts/audit/check-reachability.mjs --self-test     # prove the scanners

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve, relative } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(process.argv[1], "../../..")
const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

/** A synthetic tree the scanners can be pointed at. Kept in TEMP, not in the repo:
 *  the repo has no script fixtures, and one inline self-test is the established
 *  shape here (compare-fork-branches.mjs:57). */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-"))
  const put = (rel, text) => {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, text, "utf8")
  }

  // class 1: `Wired` is imported by non-test code, `Orphan` is not.
  put("packages/alpha/src/index.ts", [
    "export function Wired() { return 1 }",
    "export function Orphan() { return 2 }",
    "export type OnlyAType = string",
  ].join("\n"))
  put("packages/alpha/src/use.ts", 'import { Wired } from "@i-harness/alpha"\nWired()\n')
  put("packages/alpha/test/orphan.test.ts", 'import { Orphan } from "@i-harness/alpha"\nOrphan()\n')

  // class 2: `beta/change` is appended; `beta/ghost` is only declared and read.
  put("packages/beta/src/events.ts", 'export type E = "beta/change" | "beta/ghost"\n')
  put("packages/beta/src/write.ts", 'const e: E = "beta/change"\n')
  put("packages/beta/test/ghost.test.ts", 'const e: E = "beta/ghost"\n')

  // class 3: `--yes` is parsed into flags and never read; `--model` is read.
  put("apps/tool/src/index.ts", [
    "type Flags = { yes: boolean; model?: string }",
    "const flags: Flags = { yes: false }",
    'case "--yes": flags.yes = true; break',
    'case "--model": flags.model = next(); break',
    "run(flags.model)",
  ].join("\n"))

  return dir
}

const SCANNERS = []          // filled in by Tasks 2-4
const SELF_TEST_CASES = []   // { name, run(fixtureRoot) -> string[] } expected subjects

function runSelfTest() {
  const root = buildFixture()
  let ok = 0
  try {
    for (const c of SELF_TEST_CASES) {
      const got = c.run(root).slice().sort().join(",")
      const want = c.expect.slice().sort().join(",")
      if (got === want) { ok++; console.log(`  ok   ${c.name}`) }
      else console.log(`  FAIL ${c.name}\n       expected [${want}]\n       got      [${got}]`)
    }
  } finally {
    if (!process.env.KEEP_FIXTURE) rmSync(root, { recursive: true, force: true })
    else console.log(`  fixture kept at ${root}`)
  }
  console.log(`\nself-test: ${ok}/${SELF_TEST_CASES.length} ok`)
  return { ok, total: SELF_TEST_CASES.length }
}

if (args.includes("--self-test")) {
  const { ok, total } = runSelfTest()
  process.exit(ok === total && total > 0 ? 0 : 1)
}
```

- [ ] **Step 2: Run it — it must fail**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `self-test: 0/0 ok` and **exit 1**, because `SELF_TEST_CASES` is empty. That exit 1 is the red state: the harness exists and refuses to pass with nothing to test.

- [ ] **Step 3: Add the file index and the default (no-findings) run path**

Append to the same file:

```js
// ------------------------------------------------------------------ file index
function collectTs(dir, out = []) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "lib") continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collectTs(full, out)
    else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

function isTestPath(abs) {
  return /[\\/]tests?[\\/]/.test(abs) || /\.test\.tsx?$/.test(abs)
}

/** One pass over the tree. `rel` always uses forward slashes so scanners can
 *  match on stable path prefixes regardless of platform. */
function indexTree(root) {
  return collectTs(root).map((abs) => {
    let text = ""
    try { text = readFileSync(abs, "utf8") } catch { /* unreadable file is not a finding */ }
    return { abs, rel: relative(root, abs).split("\\").join("/"), test: isTestPath(abs), text }
  })
}

// ----------------------------------------------------------------------- main
if (!args.includes("--self-test")) {
  const files = indexTree(resolve(argVal("--root", ROOT)))
  const findings = SCANNERS.flatMap((s) => s(files))

  if (AS_JSON) {
    console.log(JSON.stringify({ root: resolve(argVal("--root", ROOT)), findings }, null, 2))
  } else {
    console.log(`reachability: ${files.length} ts files, ${findings.length} finding(s)\n`)
    for (const f of findings) console.log(`  ${f.kind.padEnd(22)} ${f.subject.padEnd(52)} ${f.evidence}`)
  }
  process.exit(0)
}
```

- [ ] **Step 4: Run against the real tree — expect zero findings and exit 0**

Run: `node scripts/audit/check-reachability.mjs`
Expected: `reachability: N ts files, 0 finding(s)`, exit 0. `N` is in the low hundreds; the exact number is recorded in Task 5, not asserted here.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit/check-reachability.mjs
git commit -m "feat(audit): a reachability checker skeleton, with an inline self-test"
```

---

### Task 2: Class 1 — an exported name nothing on a production path imports

**Files:**
- Modify: `scripts/audit/check-reachability.mjs`

**Interfaces:**
- Consumes: `indexTree`, `SCANNERS`, `SELF_TEST_CASES` from Task 1.
- Produces: `exportedNames(text) -> string[]`; `scanUnusedExports(files) -> Finding[]` where `Finding = { kind, subject, evidence }`.

- [ ] **Step 1: Write the failing self-test case**

Add to `SELF_TEST_CASES` (above `runSelfTest`):

```js
SELF_TEST_CASES.push({
  name: "class 1: an export only a test imports is a finding",
  expect: ["@i-harness/alpha#Orphan", "@i-harness/alpha#OnlyAType"],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/alpha#"))
  },
})
```

Add the same case for the other direction, so the scanner cannot pass by reporting everything:

```js
SELF_TEST_CASES.push({
  name: "class 1: an export a production file imports is NOT a finding",
  expect: [],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s === "@i-harness/alpha#Wired")
  },
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: both new cases FAIL — `scanUnusedExports is not defined`. Exit 1.

- [ ] **Step 3: Implement the scanner**

Add above `SELF_TEST_CASES`:

```js
// ------------------------------------------------- class 1: unused export
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST = /^export\s*(?:type\s*)?\{([^}]*)\}/gm

function exportedNames(text) {
  const names = new Set()
  for (const m of text.matchAll(EXPORT_DECL)) names.add(m[1])
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(",")) {
      const t = part.trim()
      if (!t) continue
      const alias = t.split(/\s+as\s+/)
      names.add((alias[1] ?? alias[0]).trim())
    }
  }
  return [...names]
}

/** A name is "used" when some NON-TEST file other than its own entry point
 *  both mentions the name and refers to the package. Requiring both is what
 *  keeps a same-named symbol in an unrelated package from counting as usage. */
function scanUnusedExports(files) {
  const prod = files.filter((f) => !f.test)
  const findings = []
  for (const entry of prod.filter((f) => /^packages\/[^/]+\/src\/index\.ts$/.test(f.rel))) {
    const pkg = "@i-harness/" + entry.rel.split("/")[1]
    for (const name of exportedNames(entry.text)) {
      const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`)
      const used = prod.some((f) => f !== entry && f.text.includes(pkg) && word.test(f.text))
      if (!used) findings.push({ kind: "unused-export", subject: `${pkg}#${name}`, evidence: entry.rel })
    }
  }
  return findings
}

SCANNERS.push(scanUnusedExports)
```

- [ ] **Step 4: Run to verify both cases pass**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `self-test: 2/2 ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit/check-reachability.mjs
git commit -m "feat(audit): reachability class 1, an export no production file imports"
```

---

### Task 3: Classes 2 and 3 — an event with no producer, a flag that is parsed but never read

**Files:**
- Modify: `scripts/audit/check-reachability.mjs`

**Interfaces:**
- Consumes: `indexTree`, `SCANNERS`, `SELF_TEST_CASES`.
- Produces: `scanProducerlessEvents(files) -> Finding[]`; `scanUnreadFlags(files) -> Finding[]`.

- [ ] **Step 1: Write the failing self-test cases**

```js
SELF_TEST_CASES.push({
  name: "class 2: an event only declared and read, never constructed, is a finding",
  expect: ["beta/ghost"],
  run(root) {
    return scanProducerlessEvents(indexTree(root)).map((f) => f.subject)
  },
})

SELF_TEST_CASES.push({
  name: "class 3: a flag parsed into the flags object and never read is a finding",
  expect: ["--yes"],
  run(root) {
    return scanUnreadFlags(indexTree(root)).map((f) => f.subject)
  },
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: the two new cases FAIL (`not defined`); the two class-1 cases still pass. Exit 1.

- [ ] **Step 3: Implement both scanners**

```js
// ------------------------------------------- class 2: event with no producer
const EVENT_LITERAL = /"([a-z][a-z0-9-]*\/[a-z0-9-]+)"/g
const EVENT_DECL_FILE = /(^|\/)(events?|manifest|public-event-manifest)\.ts$/

/** An event name is "produced" when a NON-TEST file other than the file that
 *  declares the union contains the same string literal outside a type position.
 *  A union member is a declaration; a literal in a value position is a use. */
function scanProducerlessEvents(files) {
  const prod = files.filter((f) => !f.test)
  const findings = []
  for (const decl of prod.filter((f) => EVENT_DECL_FILE.test(f.rel))) {
    const names = new Set([...decl.text.matchAll(EVENT_LITERAL)].map((m) => m[1]))
    for (const name of names) {
      const produced = prod.some((f) => {
        if (f === decl) return false
        const lines = f.text.split(/\r?\n/)
        return lines.some((ln) => ln.includes(`"${name}"`) && !/^\s*(?:\/\/|\*)/.test(ln) && !/\btype\b|:\s*[A-Z]/.test(ln))
      })
      if (!produced) findings.push({ kind: "producerless-event", subject: name, evidence: decl.rel })
    }
  }
  return findings
}

// ------------------------------------------------ class 3: flag never read
const FLAG_CASE = /case\s+"(--[a-z0-9-]+)"\s*:\s*flags\.([A-Za-z_$][\w$]*)\s*=/g

/** A flag is "read" when its field name appears somewhere in the same file other
 *  than its declaration, its initialiser and the `case` that assigns it. */
function scanUnreadFlags(files) {
  const findings = []
  for (const f of files.filter((x) => !x.test)) {
    const assigned = new Map()
    for (const m of f.text.matchAll(FLAG_CASE)) assigned.set(m[2], m[1])
    for (const [field, flag] of assigned) {
      const lines = f.text.split(/\r?\n/)
      const read = lines.some((ln) => {
        if (ln.includes(`case "${flag}"`)) return false
        if (new RegExp(`\\b${field}\\s*:`).test(ln)) return false
        if (new RegExp(`\\b${field}\\s*=`).test(ln)) return false
        return new RegExp(`\\b${field}\\b`).test(ln)
      })
      if (!read) findings.push({ kind: "unread-flag", subject: flag, evidence: f.rel })
    }
  }
  return findings
}

SCANNERS.push(scanProducerlessEvents, scanUnreadFlags)
```

- [ ] **Step 4: Run to verify all four cases pass**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `self-test: 4/4 ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit/check-reachability.mjs
git commit -m "feat(audit): reachability classes 2 and 3, producerless events and unread flags"
```

---

### Task 4: Classes 4 and 5 — a capability never pushed, a setting never consulted

**Files:**
- Modify: `scripts/audit/check-reachability.mjs`

**Interfaces:**
- Consumes: `indexTree`, `SCANNERS`, `SELF_TEST_CASES`.
- Produces: `scanUnpushedCapabilities(files) -> Finding[]`; `scanUnconsultedSettings(files) -> Finding[]`.

- [ ] **Step 1: Write the failing self-test cases**

Extend `buildFixture()` with a capabilities list and a settings schema:

```js
  // class 4: `plan-mode` appears in the capability union but is never pushed.
  put("packages/gamma/src/caps.ts", 'export type Cap = "plan-mode" | "vim-mode"\n')
  put("packages/gamma/src/push.ts", 'caps.push("vim-mode")\n')

  // class 5: `compaction.auto` is in the schema, nothing reads it; `notify.on` is read.
  put("packages/delta/src/schema.ts", 'export const S = { "compaction.auto": b, "notify.on": b }\n')
  put("packages/delta/src/read.ts", 'const x = s["notify.on"]\n')
```

```js
SELF_TEST_CASES.push({
  name: "class 4: a capability in the union that is never pushed is a finding",
  expect: ["plan-mode"],
  run(root) { return scanUnpushedCapabilities(indexTree(root)).map((f) => f.subject) },
})

SELF_TEST_CASES.push({
  name: "class 5: a settings key with a schema entry and no reader is a finding",
  expect: ["compaction.auto"],
  run(root) { return scanUnconsultedSettings(indexTree(root)).map((f) => f.subject) },
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `self-test: 4/6 ok` — the two new cases FAIL, the four earlier ones pass. Exit 1.

- [ ] **Step 3: Implement both scanners**

```js
// ------------------------------------- class 4: capability never pushed
const CAP_UNION_FILE = /(^|\/)(caps|capabilities)\.ts$/
const CAP_PUSH = /\.push\(\s*"([^"]+)"/

function scanUnpushedCapabilities(files) {
  const prod = files.filter((f) => !f.test)
  const findings = []
  for (const decl of prod.filter((f) => CAP_UNION_FILE.test(f.rel))) {
    const names = new Set([...decl.text.matchAll(/"([a-z][a-z0-9-]+)"/g)].map((m) => m[1]))
    const pushed = new Set(prod.flatMap((f) => [...f.text.matchAll(CAP_PUSH)].map((m) => m[1])))
    for (const n of names) {
      if (!pushed.has(n)) findings.push({ kind: "unpushed-capability", subject: n, evidence: decl.rel })
    }
  }
  return findings
}

// ------------------------------------ class 5: setting never consulted
const SETTING_KEY = /"([a-z][a-zA-Z0-9-]*\.[a-zA-Z0-9.-]+)"\s*:/g
const SETTINGS_SCHEMA_FILE = /(^|\/)(schema|settings-schema)\.ts$/

function scanUnconsultedSettings(files) {
  const prod = files.filter((f) => !f.test)
  const findings = []
  for (const decl of prod.filter((f) => SETTINGS_SCHEMA_FILE.test(f.rel))) {
    const keys = new Set([...decl.text.matchAll(SETTING_KEY)].map((m) => m[1]))
    for (const key of keys) {
      const read = prod.some((f) => f !== decl && (f.text.includes(`"${key}"`) || f.text.includes(`'${key}'`)))
      if (!read) findings.push({ kind: "unconsulted-setting", subject: key, evidence: decl.rel })
    }
  }
  return findings
}

SCANNERS.push(scanUnpushedCapabilities, scanUnconsultedSettings)
```

- [ ] **Step 4: Run to verify all six cases pass**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `self-test: 6/6 ok`, exit 0.

- [ ] **Step 5: Prove the self-test can fail (mutation proof)**

In a scratch copy of the tree, not the repo: change one fixture expectation to something wrong and confirm the harness reports `FAIL` and exits 1. Do not commit this change; it exists to show the self-test is a detector and not a rubber stamp.

```powershell
Copy-Item scripts\audit\check-reachability.mjs "$env:TEMP\cr-mut.mjs"
(Get-Content "$env:TEMP\cr-mut.mjs" -Raw).Replace('expect: ["--yes"]', 'expect: ["--nope"]') |
  Set-Content "$env:TEMP\cr-mut.mjs" -Encoding UTF8
node "$env:TEMP\cr-mut.mjs" --self-test
Remove-Item "$env:TEMP\cr-mut.mjs"
```
Expected: `FAIL class 3`, `self-test: 5/6 ok`, exit 1.

- [ ] **Step 6: Commit**

```bash
git add scripts/audit/check-reachability.mjs
git commit -m "feat(audit): reachability classes 4 and 5, unpushed capabilities and unconsulted settings"
```

---

### Task 5: Run the sweep, adjudicate every finding, and commit the baseline

**Files:**
- Create: `docs/audit/2026-09-15-reachability-baseline.md`

**Interfaces:**
- Consumes: the finished `scripts/audit/check-reachability.mjs`.
- Produces: the baseline document M1 Phase B and milestone M2 consume. Its **allowlist rows are the only orphans permitted to remain**, and its **still-holds rows are the input to the Phase B fix plan**.

- [ ] **Step 1: Run the scanner and capture the machine fingerprint**

```powershell
node scripts/audit/check-reachability.mjs --json > "$env:TEMP\reach.json"
node --version; pnpm --version; git rev-parse HEAD
```
Expected: a JSON file with a `findings` array, plus the three fingerprint values. **Record all three in the document** — the roadmap's §3.M3 learned that a baseline without a machine fingerprint is not reproducible (`HANDOFF.md` records node v24.15.0 on the authoring machine; this one runs v22.23.2).

- [ ] **Step 2: Adjudicate every finding against the three source lists**

For **each** finding, decide exactly one of:

- **`already-fixed`** — the claim in the source document no longer holds. Evidence: the file/line that now wires it.
- **`still-holds`** — a real orphan. This becomes a Phase B fix task.
- **`by-design`** — intentional public API or deliberate deferral. This becomes an allowlist row and **requires a reason sentence**, not just a label.

The three lists to reconcile, copied from the roadmap's §3.M1 (they are the sweep's input, and each item is a checklist row in the document):

| Source | Items |
|---|---|
| D1 §跨包主線 8 | no tool schema declares `sandbox_permissions`; the sandbox escalation module appears only in tests; `buildWireClient`; `mountPreset`; `withdrawPlanModeTool`; `sandbox/mode` has no producer; `tui --yes`; `estimateAssemblyOverhead` / `bindAuthRefreshStatus` |
| D1 §未竟事項 | `core-session` `migrate()` is a no-op; `goal` round admission unimplemented; `session-query` `SearchHit.time` is index time; `output-retention` bare `createSpillStore` never cleans up; `workspace` defers `delete`/`insertBefore`/`follow`/`status`; `lsp` forces one server per run |
| sandbox spec §7 | shell runtime denial unclassified; `exitCode: -1` is six-valued; `allowed-once` consumed by a call that fails for an unrelated reason; the `sandbox/mode` scenario has no producer |
| CLI surface | `tui --yes` parsed but never read; unknown subcommands not rejected; no `--flag=value` support; `i-harness run --help` runs a task named `"--help"` |

**Two rows are already measured** — carry them in as `already-fixed` with their evidence rather than re-deriving them: `sandbox_permissions` is declared at `packages/fs/src/index.ts:81,247,250`, and the escalation module is used at `packages/sandbox/src/denial.ts:91,93`.

- [ ] **Step 3: Write the document**

Create `docs/audit/2026-09-15-reachability-baseline.md` with exactly these sections, in this order:

1. **What this is** — one paragraph. A measured baseline, not a census; the tool proves only that nothing on a production path mentions the name.
2. **Machine fingerprint** — node, pnpm, HEAD, and the scanner's file count.
3. **The finding table** — one row per finding: `kind | subject | evidence | verdict | note`. Verdicts are `already-fixed` / `still-holds` / `by-design`.
4. **The source-list reconciliation** — the four lists above, each item with its verdict and evidence. An item the scanner did not surface is still a row; say why it did not surface.
5. **The allowlist** — every `by-design` finding with its reason sentence.
6. **What this does not establish** — at minimum: the tool is a heuristic; it did not check reachability *within* a call graph; items not on the four lists were not swept; `still-holds` is a claim about the current HEAD only.

- [ ] **Step 4: Verify the gates did not move**

```powershell
Remove-Item env:NO_COLOR -ErrorAction SilentlyContinue
pnpm -r typecheck
node scripts/audit/check-thresholds.mjs
```
Expected: `typecheck` exit 0; `ALL THRESHOLDS PASS`. Neither may differ from the value recorded at Task 1 Step 4.

- [ ] **Step 5: Commit**

```bash
git add docs/audit/2026-09-15-reachability-baseline.md
git commit -m "docs(audit): the reachability baseline, with its allowlist and machine fingerprint"
```

---

## Self-Review

**1. Spec coverage.** Roadmap §3.M1 asks for three things: a re-measurement against current HEAD (Task 5), a re-runnable script (Tasks 1–4), and a reasoned allowlist (Task 5 Step 3 §5). Roadmap §3.M2 consumes the baseline (Task 5's output) and the five classes (Tasks 2–4). **Gap, deliberate and stated:** M1's *fixes* (`still-holds` items being wired up) are **not** in this plan — they cannot be enumerated until Task 5 produces the table, and the roadmap's §3.M1 completion criterion covers them. Phase B is a separate plan whose input is this document. This is recorded in the header, not left implicit.

**2. Placeholder scan.** No TBD/TODO. Every code step carries runnable code. Task 5 Step 3 specifies section-by-section content rather than prose to copy, because its content *is* the measurement — writing it in advance would be inventing results.

**3. Type consistency.** `Finding = { kind, subject, evidence }` is produced by all five scanners and consumed unchanged by the runner, the JSON output and the self-test. `indexTree(root) -> File[]` with `File = { abs, rel, test, text }` is used identically throughout. `rel` is forward-slashed everywhere, which Tasks 2–4's `^packages/...` patterns depend on. The CLI surface declared in Task 1 (`--root`, `--json`, `--self-test`) is the only one used later.
