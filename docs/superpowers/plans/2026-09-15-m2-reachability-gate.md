# M2 — Reachability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the M1 reachability instrument into a **ratchet gate**: a re-runnable script that fails on *newly introduced* orphans, seeded from a dated machine-readable baseline plus a dated, reasoned allowlist.

**Architecture:** `scripts/audit/check-reachability.mjs` already enumerates five classes of "declared but unreachable" symbols and prints `731 ts files, 523 finding(s)`. M2 adds three things to that same script — a canonical **row identity** with a machine-computed **digest**, a **baseline** comparison that fails only on rows that are neither in the baseline nor allowlisted, and a **per-class tally that states each class's epistemic status** — plus two data files it reads. No new dependency: the tool stays on `node:*`.

**Tech Stack:** Node ≥ 22.18, ESM, zero external dependencies (repo discipline). The script is run directly (`node scripts/audit/check-reachability.mjs`) and has no test framework of its own — its tests are **inline self-test cases** in the same file, run by `--self-test`, which is the established shape here (`compare-fork-branches.mjs:57` is the precedent cited in the file's own header).

**Spec:** `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §M2 (`M2 — 可達性閘門`, lines 104–127) is the authority. Two further documents carry binding inheritance requirements: `docs/handoff/2026-09-15-m1-phase-b-handoff.md` §6 ("M2 (the reachability gate) must inherit") and `docs/audit/2026-09-15-reachability-baseline.md` §6 (the allowlist), §6.3 (the ratchet's baseline population) and §7 items 12–14 (the blind spots).

## Global Constraints

- **Backend only.** The TUI and web are **frozen and slated for replacement**: do not modify `apps/tui`, `packages/tui`, `packages/tui-core`, `packages/web`, `packages/web-host`, or `apps/cli/src/web.ts`. `scripts/audit/**` and `docs/**` are in scope; `apps/cli` (except `web.ts`) and `packages/*` are out of scope for M2.
- **Zero new dependencies.** The tool uses `node:*` builtins only. Nothing may be installed.
- **Keep the tree compiling.** `pnpm -r typecheck` must stay exit 0 — M2 touches no TypeScript, and if it does, that is a defect.
- **Red-first, and mutation-proof.** A test that passes while the defect is present is not a test. The milestone's own completion definition is a **mutation proof**: the gate must **fail** on a deliberately added orphan.
- **The instrument is the acceptance check.** After every task run `node scripts/audit/check-reachability.mjs` and record the finding count. **Do not adjust the scanner to make a row disappear** — the gate's whole point is that the row set is stable while the code changes.
- **Never amend a reported commit.** New commits only.
- **Verify before asserting.** Every count, line and revision a task publishes must be re-measured in the tree it is written in. This milestone's predecessor shipped five false "corrections"; that is the failure mode.
- **Read back every edited region verbatim** and confirm no splice damage — no duplicated line, no orphaned fragment.
- **Line endings:** preserve each file's existing convention (the repo has no `.gitattributes`; `core.autocrlf=true`, so blobs are LF). Never introduce a BOM; byte-check what you edit.
- **Do not rewrite history in documents.** Corrections are dated, say what was wrong, what it is now, and how it was measured.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/audit/check-reachability.mjs` | modify — add `rowKey`/`findingsDigest`, `--digest`, `--seed-baseline`, `--gate`, the per-class tally, and the self-test cases | 1, 2, 3, 4 |
| `scripts/audit/reachability-baseline.json` | **create** — the dated seeded row set (data consumed by `--gate`) | 2 |
| `scripts/audit/reachability-allowlist.json` | **create** — dated entries with reasons, keyed by `kind<TAB>subject` | 3 |
| `apps/tsconfig`/`package.json` (root) | modify — a `verify:reachability` script entry | 4 |
| `docs/handoff/HANDOFF.md` | modify — add the gate to the §5 gate list | 4 |
| `docs/handoff/2026-09-15-m1-phase-b-handoff.md` | modify — close the "M2 must inherit" list with what actually landed | 4 |
| `docs/audit/2026-09-15-reachability-baseline.md` | modify — record that the gate now exists and where the baseline/allowlist live | 4 |

**Row identity, defined once and used by all three:** `rowKey(f) = `${f.kind}\t${f.subject}\t${f.evidence}``. The baseline stores these keys; the allowlist keys on `kind<TAB>subject` (evidence is what moves when a file is refactored, so an allowlist entry must survive that); the digest hashes the sorted, newline-terminated `rowKey` lines.

---

### Task 1: The tool computes the digest it publishes

**Why first:** the baseline cannot be trusted until the tool can produce the identity it is keyed on, and this task proves the tool reproduces the value M1 published by hand (`5acf81aaf9733c88fbcb7471fcef00247c8c24804276cdcdcbfae0ffeab97786`). It is small, and every later task depends on the identity being right.

**Files:**
- Modify: `scripts/audit/check-reachability.mjs` (imports at `:22-24`; add a section after the `SCANNERS` definitions and before `function main()`; add a case to the self-test block that begins at `:701`)
- Test: the same file (`--self-test`)

**Interfaces:**
- Consumes: the existing `SCANNERS` array (`(files) => findings[]`), `indexTree(root)`, and the finding shape `{ kind, subject, evidence }` produced by `--json`.
- Produces: `rowKey(f) -> string`; `findingsDigest(findings) -> string` (lowercase hex sha256); a `--digest` CLI flag that prints the digest alone on stdout; a `digest` field added to the `--json` payload. Task 2's `--seed-baseline` and `--gate` call both functions.

- [ ] **Step 1: Write the failing test**

Add to the self-test block (immediately before the `runSelfTest` function definition, after the last existing `SELF_TEST_CASES.push`):

```js
SELF_TEST_CASES.push({
  name: "digest: the published M1 digest is reproduced from the findings",
  expect: [findingsDigest(SELF_TEST_PUBLISHED_FINDINGS)],
  run() {
    return [findingsDigest(SELF_TEST_PUBLISHED_FINDINGS)]
  },
})
```

and, next to the other fixture helpers, the fixture that pins the *conventions* rather than the row set:

```js
/** The three conventions the digest depends on, each pinned by a published
 *  counterfactual in the baseline document §2.1: sort order, LF joining, and
 *  a trailing newline on EVERY line. The row set is synthetic so the case does
 *  not rot when the repo's own rows move. */
const SELF_TEST_PUBLISHED_FINDINGS = [
  { kind: "unused-export", subject: "@i-harness/b#Two", evidence: "packages/b/src/index.ts" },
  { kind: "unused-export", subject: "@i-harness/a#One", evidence: "packages/a/src/index.ts" },
]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: **FAIL** on the new case with `findingsDigest is not defined` — the harness prints `FAIL <name>` and continues (it catches a thrown scanner so the `N/M` line still prints), and the process exits 1.

- [ ] **Step 3: Write the minimal implementation**

Add `createHash` to the existing `node:crypto` import list — there is none today, so this is a **new import line** beside `node:fs`/`node:path`/`node:os`:

```js
import { createHash } from "node:crypto"
```

Then, in the section that owns row identity (place it immediately before `function main()`):

```js
// ------------------------------------------------------- row identity + digest
/** The canonical identity of a finding. The digest, the baseline and the gate
 *  all key on this exact string, so it is defined once, here. */
function rowKey(f) {
  return `${f.kind}\t${f.subject}\t${f.evidence}`
}

/** sha256 over the findings rendered as sorted `kind ⇥ subject ⇥ evidence`
 *  lines, LF-joined, with EVERY line newline-terminated. All three conventions
 *  are load-bearing and are published as counterfactuals in
 *  docs/audit/2026-09-15-reachability-baseline.md §2.1: dropping the trailing
 *  newline and sorting by locale both produce different digests, which is why
 *  the rule is stated rather than assumed. */
function findingsDigest(findings) {
  const text = findings.map(rowKey).sort().map((l) => `${l}\n`).join("")
  return createHash("sha256").update(text, "utf8").digest("hex")
}
```

Then extend the CLI: `--digest` prints only the digest; `--json` gains a `digest` field. In `main()`, after `const findings = SCANNERS.flatMap((s) => s(files))`:

```js
  if (args.includes("--digest")) {
    console.log(findingsDigest(findings))
    return 0
  }
```

and change the JSON branch to include it:

```js
  if (AS_JSON) {
    console.log(JSON.stringify({ root, digest: findingsDigest(findings), findings }, null, 2))
```

Also extend the usage comment at the top of the file (the block at `:16-20`) with the two new lines:

```js
//   node scripts/audit/check-reachability.mjs --digest          # the row-set digest
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `self-test: 19/19 ok` and exit 0 (18 existing + 1 new).

- [ ] **Step 5: Prove it on the real tree**

Run: `node scripts/audit/check-reachability.mjs --digest`
Expected: exactly `5acf81aaf9733c88fbcb7471fcef00247c8c24804276cdcdcbfae0ffeab97786` — the digest the M1 baseline publishes. **If it differs, stop and report**: the row set has moved, and every later task keys on it. Also run `node scripts/audit/check-reachability.mjs --digest` twice and confirm it is stable, and `git stash`-free: do not mutate the tree to make it match.

- [ ] **Step 6: Commit**

```bash
git add scripts/audit/check-reachability.mjs
git commit -m "feat(audit): the reachability tool computes the digest it publishes"
```

---

### Task 2: The baseline, and the ratchet that fails only on new rows

**Files:**
- Modify: `scripts/audit/check-reachability.mjs`
- Create: `scripts/audit/reachability-baseline.json` (by running the tool, not by hand)
- Test: the same file (`--self-test`) plus a synthetic-root run

**Interfaces:**
- Consumes: `rowKey`, `findingsDigest` (Task 1); `indexTree`, `SCANNERS`, `main()`'s existing `--root` guard.
- Produces: `loadJsonIfPresent(path) -> object | undefined`; `gateDiff(current, baseline, allowlist) -> { added: string[], removed: string[] }` (both sorted); CLI modes `--seed-baseline` and `--gate`; path overrides `--baseline <path>` and `--allowlist <path>`; exit codes — `0` pass, `1` new rows, `2` usage/missing baseline. Task 3 consumes `gateDiff`'s `allowlist` argument; Task 4 consumes the exit codes.

- [ ] **Step 1: Write the failing test**

```js
SELF_TEST_CASES.push({
  name: "gate: a row the baseline does not have is the ONLY failure",
  expect: ["unused-export\t@i-harness/alpha#Orphan\tpackages/alpha/src/index.ts"],
  run(root) {
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const present = current[0]
    // Baseline holds every row BUT one: the reported failure must be exactly
    // the missing one, and a removed row must never be reported as a failure.
    const baseline = { rows: current.filter((k) => k !== present) }
    const { added } = gateDiff(current, baseline, { entries: [] })
    return added
  },
})
```

```js
SELF_TEST_CASES.push({
  name: "gate: an identical row set passes, and a removed row is not a failure",
  expect: [],
  run(root) {
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const baseline = { rows: [...current, "unused-export\t@i-harness/alpha#SinceRemoved\tpackages/alpha/src/index.ts"] }
    const { added } = gateDiff(current, baseline, { entries: [] })
    return added
  },
})
```

```js
SELF_TEST_CASES.push({
  name: "gate: a row the ALLOWLIST names never fails, even when it is new",
  expect: [],
  run(root) {
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const first = current[0]
    const allowlist = { entries: [{ key: first.split("\t").slice(0, 2).join("\t"), reason: "test", dated: "2026-09-15" }] }
    const { added } = gateDiff(current, { rows: current.filter((k) => k !== first) }, allowlist)
    return added
  },
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: three new FAILs, each `gateDiff is not defined`; the existing 19 still pass; exit 1.

- [ ] **Step 3: Write the minimal implementation**

```js
// ------------------------------------------------------------ baseline + gate
const BASELINE_DEFAULT = join(ROOT, "scripts/audit/reachability-baseline.json")
const ALLOWLIST_DEFAULT = join(ROOT, "scripts/audit/reachability-allowlist.json")

/** A missing optional data file is not an error here: `--allowlist` is legal to
 *  omit, and `--gate` reports the missing BASELINE itself rather than crashing
 *  with a stack trace a caller could mistake for a scan failure. */
function loadJsonIfPresent(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new Error(`reachability: ${path} is not valid JSON: ${err.message}`)
  }
}

/** Rows that must fail the gate: present now, in neither the baseline nor the
 *  allowlist. Rows that DISAPPEARED are progress and never fail — the roadmap
 *  is explicit that the gate fails on new orphans, never on a low count, and a
 *  gate that reddens when work is done gets switched off within a week. */
function gateDiff(current, baseline, allowlist) {
  const known = new Set(baseline?.rows ?? [])
  const allowed = new Set((allowlist?.entries ?? []).map((e) => e.key))
  const added = current.filter((k) => !known.has(k) && !allowed.has(allowlistKey(k)))
  const removed = [...known].filter((k) => !current.includes(k))
  return { added: added.slice().sort(), removed: removed.slice().sort() }
}

/** The allowlist's key for a row, which is `kind<TAB>subject` -- deliberately
 *  NOT the full row key the baseline and digest use. Comparing a
 *  `kind<TAB>subject` entry against a full row key (the obvious
 *  `allowed.has(k)`) never matches ANY entry, so the allowlist would be inert
 *  while looking harmless. */
function allowlistKey(k) {
  return k.split("\t").slice(0, 2).join("\t")
}
```

Then add the two modes and the override plumbing inside `main()`, after `const findings = SCANNERS.flatMap((s) => s(files))` and **before** the `--digest`/`--json`/table branches:

```js
  const baselinePath = resolve(argVal("--baseline", BASELINE_DEFAULT))
  const allowlistPath = resolve(argVal("--allowlist", ALLOWLIST_DEFAULT))
  const current = findings.map(rowKey)

  if (args.includes("--seed-baseline")) {
    const payload = {
      seededAt: new Date().toISOString().slice(0, 10),
      digest: findingsDigest(findings),
      count: current.length,
      rows: current.slice().sort(),
    }
    writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`reachability: seeded ${payload.count} row(s) into ${baselinePath}`)
    console.log(`reachability: digest ${payload.digest}`)
    return 0
  }

  if (args.includes("--gate")) {
    let baseline
    try {
      baseline = loadJsonIfPresent(baselinePath)
    } catch (err) {
      console.error(err.message)
      return 2
    }
    if (baseline === undefined) {
      console.error(`reachability: no baseline at ${baselinePath} -- seed one with --seed-baseline`)
      return 2
    }
    const allowlist = loadJsonIfPresent(allowlistPath)
    const { added, removed } = gateDiff(current, baseline, allowlist)
    console.log(`reachability: ${current.length} row(s) now; baseline seeded ${baseline.seededAt} with ${baseline.count} (digest ${baseline.digest})`)
    if (removed.length > 0) {
      console.log(`reachability: ${removed.length} baseline row(s) no longer present (progress, not a failure):`)
      for (const k of removed) console.log(`  gone ${k}`)
    }
    if (added.length > 0) {
      console.error(`reachability: ${added.length} NEW row(s) -- the gate fails:`)
      for (const k of added) console.error(`  new  ${k}`)
      return 1
    }
    console.log("reachability: gate PASS -- no new rows")
    return 0
  }
```

Extend the usage comment with:

```js
//   node scripts/audit/check-reachability.mjs --seed-baseline   # (re)write the baseline
//   node scripts/audit/check-reachability.mjs --gate             # fail on NEW rows only
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `self-test: 22/22 ok`, exit 0.

- [ ] **Step 5: Seed the baseline from the real tree and check the gate passes on it**

Run (in this order, and record each output):

```powershell
node scripts/audit/check-reachability.mjs --seed-baseline
node scripts/audit/check-reachability.mjs --gate
```

Expected: the seed reports **523 rows** and digest `5acf81aa…`; the gate prints `gate PASS -- no new rows` and exits 0. Confirm the file's `count` is 523 and its `digest` equals `node scripts/audit/check-reachability.mjs --digest`.

- [ ] **Step 6: Prove the ratchet does NOT fire on progress (a removed row is not a failure)**

> **This step was INVERTED when the plan was written; Task 2's execution measured it and it is corrected
> here.** Deleting a row from the baseline copy does not produce `gone`: the row is still in the scan, so
> it is *absent from the baseline* and the gate correctly fails `1 NEW row(s)` with **exit 1**. A `gone …`
> line requires a baseline row the CURRENT scan no longer emits. Simulate progress from the baseline side
> instead — copy the baseline **outside the repo** and ADD a row that no scan emits:

```powershell
Copy-Item scripts/audit/reachability-baseline.json $env:TEMP\probe-baseline.json
node -e "const fs=require('node:fs');const p=process.env.TEMP+'/probe-baseline.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.rows.push('unused-export\tFAKE#Gone\tpackages/fake/src/index.ts');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
node scripts/audit/check-reachability.mjs --gate --baseline $env:TEMP\probe-baseline.json
```

Expected: exit **0**, `gate PASS -- no new rows`, and one `gone unused-export<TAB>FAKE#Gone<TAB>packages/fake/src/index.ts`
line. Nothing in the repo is modified — the copy lives outside it.

The end-to-end form of the same proof (seed a baseline from `--self-test`'s own fixture, then actually
*fix* the orphan by adding a production consumer: rows 12 → 11, one `gone …`, exit 0) is recorded in
`.superpowers/sdd/2026-09-15-m2-reachability-gate/task-2-report.md`.

- [ ] **Step 7: Commit**

```bash
git add scripts/audit/check-reachability.mjs scripts/audit/reachability-baseline.json
git commit -m "feat(audit): a ratchet gate that fails on new reachability rows only"
```

**Measured after execution (2026-09-16), so Task 3 and Task 4 do not inherit the errors this section carried:**

1. **The `gateDiff` body above was defective and is corrected in place.** Its `added` filter compared a
   two-field allowlist key against a full three-field row key, so **no allowlist entry could ever match** —
   the allowlist would have been inert while looking harmless. Task 2's own Step 1 case 3 caught it
   (measured `21/22`; the case read `expected []` / `got [unused-export @i-harness/alpha#Orphan
   packages/alpha/src/index.ts]`). The shipped fix is the `allowlistKey` helper now shown above. Mutation
   M1 — reverting it to `allowed.has(k)` — re-reddens exactly that one case and nothing else.
   **Task 3 and Task 4 must not "simplify" it back.**
2. **Step 6's expectation was inverted; it is corrected inside that step**, with the measurement that
   falsified it.
3. **`--gate` wraps only the BASELINE read in `try`/`catch`.** `const allowlist = loadJsonIfPresent(allowlistPath)`
   sits outside it, so a malformed `reachability-allowlist.json` escapes as an uncaught throw with a stack
   trace and **exit 1** — the code this milestone reserves for "new rows". Measured: `--gate --allowlist
   <malformed file>` dies inside `loadJsonIfPresent`. Task 3 creates that file and must wrap its read and
   return 2.

---

### Task 3: The allowlist, with a date and a reason per entry

**Files:**
- Modify: `scripts/audit/check-reachability.mjs` (only if the gate needs to *report* allowlist usage; `gateDiff` already consumes it)
- Create: `scripts/audit/reachability-allowlist.json`
- Test: `--self-test`

**Interfaces:**
- Consumes: `gateDiff`'s `allowlist` argument (Task 2); the baseline document's §6.1 machine-shaped table (`| kind | subject | evidence | reason sentence |`) and §6.2's source-list rows.
- Produces: an allowlist file whose entries are `{ key, reason, dated, source }`; a self-test case that asserts a **stale** entry is surfaced.

**The allowlist's key is `kind<TAB>subject`** — deliberately **not** the full row key: evidence is the part that moves when a file is refactored, and an allowlist entry whose exemption disappears because a path shifted is worse than no entry (it silently stops exempting).

- [ ] **Step 1: Derive the entries by measurement, not by assumption**

Run `node scripts/audit/check-reachability.mjs --json > $env:TEMP/reach.json`, then for every entry in `docs/audit/2026-09-15-reachability-baseline.md` §6.1 and §6.2, decide **by matching against the live rows** whether it corresponds to a row the scanner actually emits:
- §6.1's four machine rows (`producerless-event retry/start`; `unpushed-capability plan-mode`, `guardian`, `vim-mode`) are keyed exactly as the tool reports them — verify each against the JSON.
- §6.2's thirteen source-list rows are keyed by *source item*, not by row; several are marked "no row surfaced" in §6.1 (`guard-approval/src/remember.ts`, `session-query closeSessionQueries`). Those must **not** be invented as keys — record them in the file under a `noRow` array with their reason preserved, so the reason survives without pretending a row exists.
- Anything you cannot match: **leave it out and report it**, do not guess a key.

- [ ] **Step 2: Write the failing test**

```js
SELF_TEST_CASES.push({
  name: "gate: an allowlist entry with no date or reason is reported, not accepted",
  expect: ["unpushed-capability\tguardian"],
  run() {
    const allowlist = { entries: [{ key: "unpushed-capability\tguardian" }] }
    return staleAllowlistEntries(allowlist)
  },
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node scripts/audit/check-reachability.mjs --self-test`
Expected: `FAIL` with `staleAllowlistEntries is not defined`; exit 1.

- [ ] **Step 4: Write the minimal implementation**

```js
/** An allowlist entry is only legitimate with BOTH a date and a reason: the
 *  roadmap's completion definition requires it, and an undated exemption is
 *  indistinguishable from one nobody remembers granting. Returns the keys that
 *  fail that test, so `--gate` can print them and the self-test can pin it. */
function staleAllowlistEntries(allowlist) {
  return (allowlist?.entries ?? [])
    .filter((e) => !e.dated || !e.reason || String(e.reason).trim() === "")
    .map((e) => e.key)
    .sort()
}
```

Wire it into the `--gate` branch, immediately after `const allowlist = loadJsonIfPresent(allowlistPath)`:

```js
    const stale = staleAllowlistEntries(allowlist)
    if (stale.length > 0) {
      console.error(`reachability: ${stale.length} allowlist entr(ies) without a date or reason -- refusing to gate on them:`)
      for (const k of stale) console.error(`  stale ${k}`)
      return 2
    }
```

- [ ] **Step 5: Write the allowlist file from your Step 1 measurements**

`scripts/audit/reachability-allowlist.json`, exact shape:

```json
{
  "note": "Deliberate exceptions to the reachability gate. Every entry needs a date and a reason; the gate refuses to run when either is missing.",
  "entries": [
    {
      "key": "producerless-event\tretry/start",
      "reason": "<the reason sentence from the baseline document's 6.1, quoted>",
      "dated": "2026-09-15",
      "source": "docs/audit/2026-09-15-reachability-baseline.md 6.1"
    }
  ],
  "noRow": [
    { "item": "guard-approval/src/remember.ts", "reason": "<quoted>", "dated": "2026-09-15" }
  ]
}
```

- [ ] **Step 6: Run the tests and the gate**

Run:

```powershell
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
node scripts/audit/check-reachability.mjs --digest
```

Expected: `23/23 ok`; gate `PASS`; digest unchanged from Task 2 (an allowlist entry must not remove a row from the *scan*, only from the *failure set* — if the digest moved, the allowlist is filtering too early and that is a defect).

- [ ] **Step 7: Commit**

```bash
git add scripts/audit/check-reachability.mjs scripts/audit/reachability-allowlist.json
git commit -m "feat(audit): a dated, reasoned allowlist the gate refuses to run without"
```

---

### Task 4: The mutation proof, the per-class status, and the wiring

**Why its own task:** the roadmap's completion definition *is* the mutation proof ("對故意新增的一個孤兒會失敗"). A reviewer can reject this task while approving Tasks 1–3, which is exactly the boundary the plan should draw.

**Files:**
- Modify: `scripts/audit/check-reachability.mjs` (the human-table branch at `:989-991`; one self-test case; the blind-spot comments)
- Modify: `package.json` (root: add `verify:reachability`)
- Modify: `docs/handoff/HANDOFF.md` (the §5 gate list)
- Modify: `docs/handoff/2026-09-15-m1-phase-b-handoff.md` (§6, the "M2 must inherit" list)
- Modify: `docs/audit/2026-09-15-reachability-baseline.md` (a dated note: the gate exists; where the data lives)

**Interfaces:**
- Consumes: `--gate` (Task 2), the allowlist (Task 3), the existing report loop.
- Produces: a per-class tally with epistemic status in the human table; one self-test case for the cross-package-collision false negative; a re-runnable mutation-proof procedure recorded in the Phase B handoff.

- [ ] **Step 1: The mutation proof, performed for real and recorded**

Do this **before** writing any doc, because its output is what the doc cites. Use a real package entry that is not the subject of any other task — `packages/guard-repeat-tool/src/index.ts` is one — and add to its END:

```ts
export const M2_GATE_PROOF = "delete me"
```

Then run, in order, and keep the output:

```powershell
node scripts/audit/check-reachability.mjs --digest          # new digest: the row set MOVED
node scripts/audit/check-reachability.mjs --gate            # expect exit 1, naming the one new row
```

Expected: exit **1**, with `new  unused-export  @i-harness/guard-repeat-tool#M2_GATE_PROOF  packages/guard-repeat-tool/src/index.ts`. Then **revert the edit** (`git checkout -- packages/guard-repeat-tool/src/index.ts` — note this restores the index version, and the file is unchanged in the index, so it is correct here), re-run `--gate` and confirm exit **0** and the digest back to `5acf81aa…`.

- [ ] **Step 2: Add the re-runnable case so the guard does not depend on a human repeating Step 1**

```js
SELF_TEST_CASES.push({
  name: "gate: a deliberately added orphan fails the gate (the milestone's completion proof)",
  expect: ["unused-export\t@i-harness/alpha#Orphan\tpackages/alpha/src/index.ts"],
  run(root) {
    // The fixture tree already contains the orphan class 1 reports; seeding a
    // baseline from the fixture WITHOUT it is what a real "someone added an
    // export nobody calls" looks like to the gate.
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const withoutOrphan = current.filter((k) => !k.includes("#Orphan"))
    return gateDiff(current, { rows: withoutOrphan }, { entries: [] }).added
  },
})
```

- [ ] **Step 3: Print each class's count WITH its epistemic status**

The human table currently prints one summary line and a flat list (`:989-991`). Add, between them, a per-class tally — because the five classes are not equally strong evidence, and a count without that caveat is the over-claim M1 spent a review cycle removing:

```js
// Per-class tally. The status strings are not decoration: class 1 is an
// UNCONSUMED EXPORT EDGE (the symbol may still be reachable through a path the
// scanner cannot follow), 3 and 4 are LOWER BOUNDS (they depend on what the
// walker saw), and 5 is READER-DEPENDENT (a setting may be read by a consumer
// outside this tree). Printing a bare number next to them would overstate all
// four; M1's reviews removed exactly that overstatement from its documents.
const CLASS_STATUS = {
  "unused-export": "unconsumed export edge, not dead code",
  "producerless-event": "anchor is a file-name pattern; a lower bound",
  "unread-flag": "lower bound (depends on the walker's parse)",
  "unpushed-capability": "lower bound (depends on the walker's parse)",
  "unconsulted-setting": "reader-dependent (consumers outside this tree are invisible)",
}
```

and in the human-table branch:

```js
    const byKind = new Map()
    for (const f of findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
    for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${kind.padEnd(22)} ${CLASS_STATUS[kind] ?? "(no status recorded -- add one)"}`)
    }
    console.log("")
```

- [ ] **Step 4: Add the cross-package-collision case (the demonstrated false negative)**

```js
SELF_TEST_CASES.push({
  name: "class 1: a COMMENT naming a type suppresses the row (documented false negative)",
  expect: [],
  run(root) {
    // The fixture's beta entry is referenced only from a comment in another
    // package. The scanner counts the mention as usage, so no row is emitted --
    // a false NEGATIVE, pinned here so nobody reads the gate as a proof that a
    // named symbol is reachable.
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/beta#"))
  },
})
```

If the existing fixture has no such pair, **do not invent an expectation that does not hold** — instead add the fixture file the case needs (a `beta` entry plus a comment-only mention in `alpha`) and record in the case's comment that the fixture was added for it.

- [ ] **Step 5: Wire it in and close the inheritance list**

`package.json` (root), in `scripts`, alphabetically near the other `verify:*` entries:

```json
"verify:reachability": "node scripts/audit/check-reachability.mjs --gate",
```

`docs/handoff/HANDOFF.md` §5: add to the gate list, with the expected result:

```
node scripts/audit/check-reachability.mjs               # expect: 731 ts files, 523 finding(s)
node scripts/audit/check-reachability.mjs --gate        # expect: gate PASS -- no new rows
```

`docs/handoff/2026-09-15-m1-phase-b-handoff.md` §6 ("M2 (the reachability gate) must inherit"): add a dated paragraph under that heading stating, for each inherited item, what M2 did with it — seeded the ratchet from the digest ✓; the local re-export blind spot (documented in the tool, not fixed) ✓; the entry-only blind spot (documented) ✓; argument routing invisible to all classes (documented as a test-only guard) ✓; per-class epistemic status printed ✓ — and **name anything not done** rather than implying closure.

`docs/audit/2026-09-15-reachability-baseline.md`: a dated note in §2.1 saying the digest is now machine-produced (`--digest`), that the baseline lives at `scripts/audit/reachability-baseline.json`, and that the allowlist is `scripts/audit/reachability-allowlist.json` with dates and reasons.

- [ ] **Step 6: Run everything**

```powershell
node scripts/audit/check-reachability.mjs --self-test    # expect 24/24 ok
node scripts/audit/check-reachability.mjs                # expect 731 / 523 + per-class tally
node scripts/audit/check-reachability.mjs --gate         # expect PASS, exit 0
node scripts/audit/check-reachability.mjs --digest       # expect 5acf81aa...
node scripts/audit/check-thresholds.mjs                  # expect ALL THRESHOLDS PASS
pnpm -r typecheck                                        # expect exit 0
```

- [ ] **Step 7: Commit**

```bash
git add scripts/audit/check-reachability.mjs package.json docs/
git commit -m "feat(audit): the gate proves itself, states each class's strength, and is wired in"
```

---

## Self-Review

**1. Spec coverage** — the roadmap §M2 requires: a re-runnable script (Tasks 2, 4); the ratchet failing only on new orphans (Task 2, with the removed-row case pinned); a reasoned allowlist (Task 3); the five enumerated classes (already in the tool — Tasks 1–4 must not break them, and `--self-test` guards that); the completion definition's **mutation proof** (Task 4 Step 1, plus the re-runnable self-test in Step 2); dates and reasons on both data files (Tasks 2, 3). The inherited list from the Phase B handoff §6 is closed explicitly in Task 4 Step 5, with anything not done named. **Not covered, and deliberately:** the roadmap's "它不保證什麼" (the gate does not prove reachable things are *correct*) — that is a statement to publish, not work; it belongs in the gate's own output and is added to `CLASS_STATUS`'s surrounding comment in Task 4 Step 3 and restated in the handoff paragraph.

**2. Placeholder scan** — the one place this plan cannot give exact content is Task 3 Step 1's allowlist entries, because they must be *derived* from the baseline document by matching against live rows; the plan says exactly how, and forbids inventing keys. Task 4 Step 4 has a conditional fixture, with the instruction to add the fixture rather than fake an expectation.

**3. Type consistency** — `rowKey(f)` takes a finding object; `gateDiff(current, baseline, allowlist)` takes arrays/sets of **keys** (strings), and the plan's call sites always pass `.map(rowKey)`; `findingsDigest(findings)` takes finding objects; `staleAllowlistEntries(allowlist)` takes the parsed file, returns sorted keys. `--baseline`/`--allowlist` are paths; `--seed-baseline`/`--gate`/`--digest`/`--json`/`--self-test` are flags. Exit codes: `0` pass, `1` new rows, `2` usage or missing/invalid baseline or a stale allowlist.

**Known limitation, stated so nobody reads the gate as stronger than it is:** the baseline pins the row set **as of its `seededAt` date and digest**. Any legitimate row *removal* is silent progress (reported, not failed); any legitimate row *addition* must be accepted deliberately by re-seeding, which is the point of a ratchet but also its cost.
