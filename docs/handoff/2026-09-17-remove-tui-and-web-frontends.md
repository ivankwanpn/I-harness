# M65 — removing the TUI and web frontends — milestone record

**Written:** 2026-09-17, by the session that closed it. **Branch:** `m65`. **Record measured at** `1ac091e`.
**Every figure names the revision it was measured at.** §9 says which statements are judgements rather than
measurements.

**Audience:** whoever picks this up next. This is the tracked, clone-visible record of M65 — the milestone that
deleted the TUI and web frontends, and then had to price the 104 orphan exports the deletion left behind. The
SDD ledger, task briefs, per-task reports and review files for this milestone all exist, under `.superpowers/`
— **gitignored** (`.gitignore:46`), so a clone sees none of them. This repository has recorded that mistake
once already: `docs/handoff/HANDOFF.md:232-248` (§4) records that the 2026-09-15 cycle's history once lived only in
a gitignored ledger and that this was a mistake, and M2 repaired it for itself with
`docs/handoff/2026-09-15-m2-reachability-gate-handoff.md`. This document is the same repair for M65.

**Nothing here points into `.superpowers/`.** A tracked document citing an untracked one is a dangling pointer
that rots on the next clone; where that constraint costs the reader something, §6 and §9 say so out loud.

---

## 1. What shipped

| Path | State at `1ac091e` |
|---|---|
| `apps/tui`, `packages/tui`, `packages/tui-core`, `packages/web-host`, `apps/cli/src/web.ts` | **deleted** — `git ls-files` returns 0 files for each. The deletion is `4ea5b5d` (301 files changed, 71,395 deletions) |
| `packages/web` | **survives untouched.** It is **not** a frontend: it is the `web_search` / `web_fetch` **tool** package — `createWebTools` (`packages/web/src/index.ts:45`), `registerWeb` (`:122`) — imported by the backend at `packages/session-executor/src/assembly.ts:19` (`import { registerWeb } from "@i-harness/web"`). 5 tracked files |

**The CLI's bare-launch behaviour was restored to its pre-M44 shape.** `apps/cli/src/index.ts:122-125` is now

```ts
if (args[0] !== "run") {
  console.error(USAGE)
  return Promise.resolve(1)
}
```

with a comment at `:117-121` naming its authority, `db3d1e7^:apps/cli/src/index.ts`. Re-opened there: the
pre-M44 file has the identical shape at its `:103-106` — `console.error("usage: i-harness <run|web|sdk|acp> …")`
then `return Promise.resolve(1)` — and `db3d1e7` ("feat(m44): global commands — … grok-style bare-launch TUI
default …") is the commit that replaced it with a TUI launch for any unrecognised first token. So usage goes to
**stderr** and the exit code is **1** for an absent or unknown subcommand, and the shape is restored rather than
reinvented. The `USAGE` constant itself (`:36-40`) now lists `run|sdk|acp|sessions` — no `web`, no `tui`.

The commits: the removal `4ea5b5d`; its out-of-file-list repairs `aff98d1` and `dbe2e41`; the Task-2 split
`3f6084c`; the settings retirement `144369f`; the entry-re-export retirements `8aabff4`; the re-seed
`1bc8d83`; and four audit repair rounds `c4ac17a`, `df29271`, `7d66e1c`, `1ac091e` — 11 commits after the plan
commit `2dd78b5` (`git rev-list --count 2dd78b5..HEAD`).

### 1.1 Instrument state at `1ac091e` (measured, not restated)

| Command | Result |
|---|---|
| `node scripts/audit/check-reachability.mjs` | **466 ts files, 472 finding(s)**; tally **463 unused-export / 8 unconsulted-setting / 1 producerless-event** |
| `… --digest` | `c777795c225bbc30a77917070719e00c746a27856713a2903a446fec8eb8b24e` |
| `… --gate` | exit **0**, `gate PASS -- no new rows`; `472 row(s) now; baseline seeded 2026-09-17 with 472` |
| `… --self-test` | **36/36 ok**, exit 0 |
| `scripts/audit/reachability-baseline.json` | `count: 472`, `seededAt: 2026-09-17`, digest `c777795c…` — identical to the live digest |

Three of the five classes emit **nothing** at this revision (no `unpushed-capability`, no `unread-flag`). That is
a fact about the tree, not a certificate about the instrument — §5 shows the gate's own blindness arriving as a
falling count.

**One comparison to know before §5.** Gating the *current* tree against **M2's 523-row baseline**
(`git show 08f30c5:scripts/audit/reachability-baseline.json`, written to a file and passed as `--baseline`)
exits **1** and prints:

```
reachability: 472 row(s) now; baseline seeded 2026-09-16 with 523 (digest 5acf81aa…)
reachability: 115 baseline row(s) no longer present (progress, not a failure):
reachability: 59 NEW row(s) -- the gate fails:
```

The 59 are the unexempted remainder of the 64 rows the frontend removal orphaned that the classification left
standing (§2). The exit code cannot carry the signal, so the readable one is **`gone` rows — 115 here, and it
must stay 115** (§5). **[Corrected 2026-09-17: the reading is `1ac091e`'s, not a constant — `gone` is
counted against a FIXED baseline, so later retirements raise it. It is 120 as of the feedback
deletion, and the instruction is to pin the *baseline*, not the number. See §10's dated correction,
which reconciles the movement.]**

---

## 2. The 104-row class — why this document exists

Deleting the frontends orphaned **104 exports**. Each had been consumed only by a deleted frontend, so the
scanner — which reports a name no *production* file mentions (`scripts/audit/check-reachability.mjs:404`,
applied at `:412`) — began reporting all of them in one step.

### 2.1 The arithmetic, re-derived

Measured by scanning each revision with the tool at `1ac091e` (`--root <a `git archive` extraction of the
revision>`). The extraction of `1ac091e` reproduces this tree's digest `c777795c…` byte-for-byte, and the
extraction of `3f6084c` scans to `44479f56…`, so the comparison is scan-equivalent rather than approximate.

| Revision | Rows | Note |
|---|---|---|
| `08f30c5` (M2's seed) | **523** | the baseline M2 committed |
| `3f6084c` (after the removal, before Task 2) | **512** | `523 − 115 + 104` |
| `144369f` (Task 2A) | **476** | `−36` = 19 T + 17 B |
| `8aabff4` (Task 2A fix) | **472** | `−4` more B rows, via the entry re-export (§4) |
| `1ac091e` (HEAD) | **472** | unchanged since `8aabff4` |

- **115 vanished.** All 115 carried an evidence path under a deleted frontend path (`apps/tui/`,
  `packages/tui/`, `packages/tui-core/`, `packages/web-host/`, `apps/cli/src/web.ts`) — **115 of 115**,
  measured, so "evidence in a deleted path" is exact and not a summary.
- **104 appeared**, across **36 declaring packages** (not the "~30" the plan estimated):
  90 `unused-export` + 14 `unconsulted-setting`.
- **64 remain** new relative to the 523 baseline: `17 + 34 + 13` below. Five of the 64 are allowlisted by
  dated entries, which is why the gate reports 59 and not 64.

**Recorded as ONE named class disposition, not 104 entries** (human ruling, 2026-09-17). The four buckets
partition exactly: **19 + 38 + 34 + 13 = 104**; and the 64 still-new rows split **17 + 34 + 13**.

### 2.2 T = 19 — TUI-only settings, DELETED

14 keys + 5 types, retired by `144369f`:

- **Keys (14).** `theme`, `busyEnter`, `transcriptMode`, plus the eleven `tui.prefs.*` paths:
  `tui.prefs.timestamps`, `.alwaysApprove`, `.scrollSpeed`, `.scrollMode`, `.scrollLines`, `.invertScroll`,
  `.keepTextSelection`, `.wordSeparators`, `.mouseReportingToggle`, `.screenMode`, `.dashboard.pinned`.
- **Types (5).** `SettingsTheme`, `SETTINGS_THEMES`, `SETTINGS_THEMES_LOW_COLOR`, `SettingsScrollMode`,
  `SettingsKeepTextSelection` — all five are gone from the package at HEAD (0 occurrences in
  `packages/settings/src/index.ts`; the only surviving mentions are in dated audit documents).
- The list is carried by a **tracked test**, which is what makes it clone-visible:
  `packages/settings/test/retired-tui-keys.test.ts:39-55` — *"The 14 `unconsulted-setting` rows the
  classification puts in bucket T."* Two neighbouring vocabulary types, `SettingsTranscriptMode` and
  `SettingsBusyEnter`, were **kept** (`packages/settings/src/index.ts:30-36`), so "the TUI types went" would be
  wrong.

**Removal is safe, and the reason is structural — verified at `1ac091e`.** `normalizeSettings`
(`packages/settings/src/index.ts:542`) is a field-by-field projection: it names each key it knows
(`:558` `sandboxMode: oneOf(raw.sandboxMode, …)`, `:561` `fontSize: numberInList(raw.fontSize, …)`) and never
reads a key it does not name. Nothing validates the document against the schema — no `satisfies`, no strict
parse — and `load()` (`:656`) wraps the read in try/catch, so even a corrupt file degrades to defaults. So
**an existing `settings.json` still loads**, and because `persist()` (`:764`) writes `rawWithPins()` (`:750`,
called at `:779`) — the *normalised* snapshot — **the retired keys are dropped from the file on the next full
write**. That is the package's documented "no migration chain, no file rewrite" stance: the drop *is* the
migration, so no migration code is warranted. Pinned red-first by the three tests in
`retired-tui-keys.test.ts` (load tolerates them; defaults and `normalizeSettings(undefined)` do not carry them;
the first write removes them and the document stays loadable).

### 2.3 B = 38 — backend-internal: the code is live, only the export lost its consumer

**21 retired** (`144369f` 17, `8aabff4` 4), **17 stand** (§3). Every retired row is live production code whose
only non-test consumer was a deleted frontend, and every one is still referenced *inside its own declaring
module* — which is why removing the export cannot produce the `TS6133` unused-declaration error that makes the
delete-only shape mandatory for a genuinely dead declaration.

Measured at HEAD by re-opening the declaring modules: of the 21, **exactly 4 are still declared and exported in
their own module** — `plugin-registry#mcpServerKey` (`src/install.ts`), `session-persistence#SessionForkUnavailableError`
and `#completedTurnPrefix` (`src/fork.ts`), `workspace#listWorkspaceFiles` (`src/files.ts`). Those four took
**shape 2** (§4); the other **17** took shape 1. By package the 21 are: workspace 5, plugin-registry 4,
session-persistence 4, workflow 3, settings 2, and one each in feedback, provider and rewind.

### 2.4 C = 34 — the frontend/wire contract

View models, DTOs and the approval / question / command seams. **The shape did not change; only the consumer
did** — measured: **all 34 declarations are byte-identical to the pre-removal tree**
(`git show 4ea5b5d^:<file>`), so nothing in the removal edited them. The source says what they are for:
`packages/jobs/src/index.ts:20` *"One job row served to the SPA"*, `:32` *"GET /api/sessions/:id/jobs response
body"*, `packages/feedback/src/index.ts:9` *"the only consumer of feedback persistence is the SPA over the web
host's HTTP routes"*.

By declaring package: jobs 8, interaction 7, goal 5, feedback 4, hooks 3, core-session 2, session-title 2,
credentials 1, provider-runtime 1, settings 1.

**These are the replacement frontend's contract, not evidence that the backend rotted**, which is why the
disposition is *deferred* rather than *deleted* — and why they are cheap to un-strand: the rebuilt frontend is
expected to consume them again. The member list, each member with the production line that still reaches it, is
in the allowlist's dated entry keyed `unused-export<TAB>@i-harness/attachment#createImageAttachmentStore`
(2026-09-17).

### 2.5 ? = 13 — deferred, each with its deciding question

- **9 collapse to one question — *does the rebuilt frontend still have that surface?***
  `attachment#createImageAttachmentStore`, `#ImageAttachmentRef`, `#ImageAttachmentStore` (does it upload
  images?), `plugin-registry#evaluatePlugin`, `#PluginConflictError` (does a host render plugin runtime /
  conflict status?), `settings#SectionOp`, `#SectionView` (does it call the section API directly or through a
  host-side wrapper?), `shell#resolveShell` (does a host resolve the platform shell at all?),
  `text-diff#renderUnifiedDiff` (does it render unified diffs?). One product call, not nine independent ones.
- **3 are `sdk` wire names — most likely an allowlist gap, not an orphan class.** `HarnessClient`,
  `ServerInfo` and `RewindFileOpWire` are the same kind of name, from the same two files (`packages/sdk/src/client.ts`,
  `packages/sdk/src/protocol.ts`), as the **17** already-allowlisted `@i-harness/sdk` names dated 2026-09-16; two of
  those seventeen are their direct siblings in `protocol.ts`. The class has not grown by three — the gap has.
- **1 was already deferred by the allowlist's own `noRow` entry** dated 2026-09-15: `preset#mountPreset`,
  whose old evidence (*"the only production mention outside the declaring module is a comment in
  `packages/tui/src/views/light-personas.ts:2`"*) is a path this milestone deleted. The deferral's premise has
  now actually happened, so the row is a live finding rather than an inert entry; the ruling is unchanged.

**Read the allowlist's mechanics before relying on any of this.** The gate's exemption lookup is **one row per
entry** (`check-reachability.mjs:1597-1602`; `allowlistKey` at `:1612`): it reduces a row to
`kind<TAB>subject` and compares for equality — no wildcard, no prefix, no class key. The C and ? entries are
therefore **dated adjudications, not exemptions**; their members are accepted through the *baseline*, which
holds them. Repairing one member of a class would warn that its entry is inert and would say nothing about its
siblings.

---

## 3. The 17 standing rows: FIVE blockers with five different owners

Not one blocker. Flattening the five is the error this distinction removed. **Partition: 11 + 1 + 1 + 3 + 1 = 17.**

| # | Blocker | Rows | Owner | What it costs |
|---|---|---|---|---|
| 1 | the assertion **is** the class identity | 11 | test-fix debt | weakening a live assertion |
| 2 | `export * from "./sections.ts"` | 2 | the settings API's owner | an API decision |
| 3 | the class-5 scanner anchor | 1 | the gate's maintainer | a detector fix (§5) |
| 4 | a test-body reroute | 3 | a test edit | three sizes an order of magnitude apart |
| 5 | a cross-package repoint | 1 | new precedent or an API decision | this repo has no precedent |

**1 — eleven error classes (test-fix debt).** `credentials#CredentialRefError`
(`credentials.test.ts:148`), `credentials#CredentialShadowedError` (`:132`), `feedback#FeedbackBadRequestError`
(`feedback.test.ts:148`), `#FeedbackNoteEmptyError` (`:149`), `#FeedbackNoteTooLargeError` (`:150`),
`#FeedbackVersionConflictError` (`:102`), `provider#ModelProbeFailedError` (`directory.test.ts:268`),
`#ProbeUnavailableError` (`:188`), `settings#SettingsConflictError` (`sections.test.ts:258`),
`workspace#WorkspaceBadRequestError` and `workspace#WorkspaceNotFoundError` (`packages/workspace/test/workspace.test.ts:69`, `:70`; and
`:94` for `NotFound`). Measured spellings: **ten** are `expect(…).toBeInstanceOf(X)` or
`.rejects.toBeInstanceOf(X)`; the eleventh — `credentials.test.ts:148` — is
`expect(() => store.describe([bad])).toThrow(CredentialRefError)`, the same class-identity claim in a different
spelling. There is no other route to the class, so un-exporting would force
`toMatchObject({ name, code })`. **A weakened assertion is worse than a row left standing** (the ruling).

**2 — two settings rows (an API decision, not a test problem).** `settings#describeSection`
(`packages/settings/src/sections.ts:299`) and `settings#SettingsConflictError` (`:70`) reach the entry only
through the star at `packages/settings/src/index.ts:1274` (`export * from "./sections.ts"`). Shape 2 (§4) is
unavailable without curating that star into an explicit list, which changes the public surface of the whole
sections API and belongs to the API's owner.

**3 — one row blocked by a detector (the gate's problem, not the row's).** `settings#SETTINGS_DEFAULTS` is
declared at `packages/settings/src/index.ts:236` and is an `unused-export` row; the remediation a class-1 row
normally takes — drop the `export` keyword, shape 1 — would blind class 5. See §5.

> **RESOLVED 2026-09-18.** The detector was fixed at `9bd45b9d` (`SETTINGS_DEFAULTS_DECL` now reads
> `\b(?:export\s+)?const`), so the remediation this blocker was waiting on became available, and the row
> was retired: `SETTINGS_DEFAULTS` is module-private and the three test files that named it as an oracle
> now obtain the same values through `normalizeSettings(undefined)`.
>
> **A correction to this document's own margin, because the wrong reason was repeated in a session
> report and nearly became the justification for real work.** The blocker was later described as *"moving
> it needs a runtime cycle: it reads `SETTINGS_STATUS_LINE_SEGMENTS` (a value), so the whole package
> imports itself"*. **That is false** — both constants are in the SAME file (`index.ts:157` and `:236`),
> so there is no cross-module edge at all. The actual cost was one **tautological assertion**:
> `expect(normalizeSettings(undefined)).toEqual(SETTINGS_DEFAULTS)` becomes `expect(X).toEqual(X)` once
> the oracle is the public accessor. It was deleted, and it never tested anything — the `undefined` case
> IS the reference the other three compare against. **The lesson is the one §5 keeps teaching: a blocker's
> stated reason has to be re-measured, not inherited.**

**4 — three rows reroutable by a test-body edit, and their sizes must not be flattened.** All three are
declared in their package entry, so shape 2 does not exist for them.

- `workspace#WorkspaceRegistry` — **one line**: the `registry: WorkspaceRegistry` annotation at
  `packages/workspace/test/workspace.test.ts:15` becomes `ReturnType<typeof createWorkspaceRegistry>` (interface declared at
  `packages/workspace/src/index.ts:149`).
- `provider#describeDirectory` — **one call site**: `directory.test.ts:821` becomes
  `defaultProviderRegistry().describeDirectory()`; the accessor is exported at
  `packages/provider/src/index.ts:658` and the standalone is defined as it at `:663-664`, so the `toEqual` at
  `directory.test.ts:822` is unchanged.
- `exec#createExecService` — **12 test files in 7 packages, 6 of them outside the declaring one** (agent-team,
  fs-search, guard-approval, guard-timeout, session-executor, subagent), rerouted by mounting through the
  exported `registerExec` (`packages/exec/src/index.ts:290`, the production mount at `:291`). Measured
  refinement: a **13th** file mentions the name only inside a string literal
  (`packages/shell/test/sandbox-refusal.test.ts:44`), which is why a naive `git grep -l` says 13 files across 8
  packages.

**5 — one row blocked by a cross-package repoint with no precedent.** `workflow#createWorkflowJobStore` is
declared at `packages/workflow/src/runner.ts:68`. Its own-package consumers already deep-import it
(`packages/workflow/test/workflow.test.ts:15`, used at `:294`, `:315`), so shape 2 is available in principle — and the
**only** breakage is `packages/subagent/test/tools.test.ts:10`, a *different package* importing it from
`@i-harness/workflow` (used at `:585`, `:601`, `:619`). The relative form that would fix it
(`"../../workflow/src/…"`) has **zero hits anywhere in this tree** (measured: `git grep '"\.\./\.\./[a-z-]*/src/'`
→ 0). The alternatives are not free: a subpath export in `packages/workflow/package.json` is an API decision, and
omitting `jobs` silently couples three subagent tests to a module-level shared store
(`packages/workflow/src/runner.ts:293`).

**Follow-up order, cheapest first:** `WorkspaceRegistry` → `describeDirectory` → `createExecService` →
`createWorkflowJobStore`. The remaining thirteen cannot be retired without weakening an assertion or making
the API/detector decision named above.

> ### STATUS 2026-09-18 — **17 → 3**
>
> The order above was followed. Retired: `WorkspaceRegistry`, `describeDirectory` and `createExecService`
> (blocker 4, the follow-up order), `SETTINGS_DEFAULTS` (blocker 3 — the detector that blocked it was fixed
> at `9bd45b9d` and nobody revisited it; see the correction below), and all eleven error classes except one
> (blocker 1, `661ed0e4` plus the settings one).
>
> **Still standing, and both are DECIDED rather than pending:**
> - `settings#describeSection` + `settings#SettingsConflictError` — the settings UI contract the frontend
>   removal stranded. Adjudicated 2026-09-18: it **survives the rebuild**, and the shape is affirmed against
>   three shipping harnesses (Codex's closed union, no per-section view registry anywhere). One allowlist
>   entry carries the class.
> - `workflow#createWorkflowJobStore` — blocker 5.
>
> **Blocker 5's stated reason is not its real cost, measured 2026-09-18.** This document says "a cross-package
> repoint with no precedent". The precedent is not what is missing — the cost is **test isolation**:
>
> ```ts
> packages/workflow/src/runner.ts:293   const jobs = deps.jobs ?? sharedJobs
> ```
>
> `jobs` is OPTIONAL and defaults to the process-shared singleton. The tests pass `jobs: createWorkflowJobStore()`
> precisely to get an isolated store; dropping the export leaves them no way to make one, so every one of them
> would share `sharedJobs` and contaminate across tests. (`workflow.test.ts:294` and `:315` hold a `store` and
> drive it directly, so they cannot simply omit the argument.) **That is a worse outcome than one standing row,
> which is why this one stays** — a different disposition from the same conclusion, and the reason matters
> because "no precedent" invites someone to go create one.
>
> **Also corrected here: the allowlist entry that carried this class is GONE, and that is correct.** Its key
> was `exec#createExecService`, which retired; the gate then reported it inert ("match no live row -- they
> exempt nothing") and it was removed. By the file's own mechanic an entry keyed on a representative row is a
> **dated adjudication of a class**, not an exemption covering it — the remaining members are accepted through
> the baseline, and the class's documentation lives HERE. **This document is now the only written adjudication
> of blockers 1 and 5's remainder**; nothing else records why they are accepted.

---

## 4. The two un-export shapes — the rule names only one

The bucket-B rule on the record — §8 of `docs/audit/2026-09-15-reachability-baseline.md:1232`, the bucket-B
table row, inside a table that opens at its `:1229` — says: **drop the `export` keyword, keep the declaration**. There
is a **second, often cheaper shape**, and `8aabff4` is its first use in this repository:

| Shape | What moves | Available when | Effect |
|---|---|---|---|
| **1 — declaration** | drop `export` at the declaration | the name is declared in the entry itself, or nothing outside its declaring module imports it by path | the name leaves the package *and* its module |
| **2 — entry re-export** | drop only the name from the package **entry's** export list / `export {…} from` | a test or a sibling module already deep-imports the declaring file | the declaration stays exported in its own module; the entry stops publishing it |

Shape 2 is unavailable where the entry reaches the file through `export *` — that would be star curation, i.e.
blocker 2 of §3.

The four shape-2 retirements and their measured cost: `workspace#listWorkspaceFiles` (`files.test.ts:5` already
deep-imports `../src/files.ts` — **zero test edits**); `plugin-registry#mcpServerKey` (`install.test.ts:10` is
already inside an import from `../src/install.ts` — zero test edits); and
`session-persistence#completedTurnPrefix` with `#SessionForkUnavailableError` (one import repoint:
`fork.test.ts:13-14` now deep-imports `../src/fork.ts` for those two names only; the assertions at `:116`,
`:128`, `:138`, `:254`, `:274` were untouched). **No assertion anywhere was edited in that commit** — which is
the standard that decides whether a row is retired or left standing.

---

## 5. The class-5 anchor defect — M2's, and the most consequential thing in this document

The instrument has five class anchors. **Four of them are literal source text, and three share an
`export`-prefix fragility.** Re-opened at `1ac091e`:

| Anchor | Line | Shape | Fallback |
|---|---|---|---|
| `EXPORT_DECL` | `check-reachability.mjs:247` | `^export\s+(function\|const\|class\|type\|interface\|enum)…` — literal `export` | **yes** — `EXPORT_LIST` (`:248`), `EXPORT_STAR` (`:249`), and the deep re-export walk (`:318`, `:341`, `:360`) |
| `EVENT_DECL_FILE` | `:423` | a **file-name** pattern (`(events?\|manifest\|public-event-manifest)\.ts$`) | none |
| `FLAG_CASE` | `:469` | literal `case "--x": flags.x =` | **none** |
| `CAP_UNION_DECL` | `:577` | `^export\s+type\s+Name\s*=` — literal `export` | **none** — `CAP_UNION_NAME` (`:578`) is a name filter and `CAP_PUSH` (`:579`) is the producer side, not a second anchor |
| `SETTINGS_DEFAULTS_DECL` | `:640` | `export const [A-Z0-9_]*DEFAULTS\b[^=]*=\s*\{` — literal `export` | **none in practice** — the second anchor, `SETTINGS_SCHEMA_FILE` (`:639`), matches **no file in this tree** (there is no `schema.ts` or `settings-schema.ts` anywhere; measured) |

So **classes 3, 4 and 5 have no fallback anchor; only class 1 has redundancy.** The tool's own comment at
`:631-638` already documents this failure mode — for a rule that never matched: the drafted file-name anchor
matched nothing, and *"the drafted scanner reported 0 findings over 33 declared key paths: a broken rule reading
as a clean sweep."* **The instance here is reachable by doing the right thing**, because "remove an unused
`export`" is precisely the remediation this milestone performed, and `SETTINGS_DEFAULTS` is the row waiting on
it (§3 blocker 3).

**Measured consequence at `1ac091e`.** Two variants, both run on copies — the repository's scanner was not
modified:

1. **Blinding the anchor.** One token changed in a copy of the scanner (`[A-Z0-9_]*DEFAULTS\b` →
   `[A-Z0-9_]*DEFAULTS_ZZZBLINDED\b`), run with `--root` pointed at this tree: findings **472 → 464**,
   `unconsulted-setting` **8 → 0**, and `--gate` against the 523-row baseline reports the `gone` count move
   **115 → 123** while its new-row count stays at **59**. **The tool reports its own blindness as progress.**
2. **Doing the remediation.** Dropping `export` at `packages/settings/src/index.ts:236` in a copy of the tree:
   findings **472 → 463** — the 8 class-5 rows *and* the `SETTINGS_DEFAULTS` row itself — with the same
   `gone` **115 → 123** (that row was new relative to the 523 baseline, so its own disappearance does not add
   to `gone`).

**Two candidate fixes** for the gate's maintainer: (a) make the anchor tolerate a missing `export`; (b) key
class 5 on the **object literal** rather than on the keyword. Either is a detector change owing its own
`--self-test` case, and the suite's limit is narrower than "it cannot see this". **Blinding the anchor outright
reddens it**: measured at `1ac091e` on a copy whose class-5 anchor is blinded, `--self-test` reports **33/36,
exit 1**, failing exactly its three class-5 fixture cases — **because the fixtures use the same anchor**. What no
case sees is a **silent loosening that leaves the fixtures matching**: drop the `export` in the real tree, leave
the scanner untouched, and the suite stays at **36/36, exit 0** while class 5 goes dark on the tree it is supposed
to measure (variant 2 above). That is precisely the limit M2 states in **its §4** — *"the self-test still cannot
see a scanner loosening that no fixture element targets"* (`docs/handoff/2026-09-15-m2-reachability-gate-handoff.md:129`,
a line inside §4, which opens at that file's `:114`; its `:130` points on to the baseline document's §7) — and the
quiet version is the dangerous one, which is why the tell is not the suite.

**What the two readings do and do not separate — measured, not reasoned.** Against the same frozen 523-row
baseline:

| state of the tree | `--digest` | `gone` |
|---|---|---|
| as committed at `1ac091e` | `c777795c…` | **115** |
| class-5 anchor blinded (variant 1) | `6fa7863c…` | **123** |
| the `export` dropped in the tree (variant 2) | `6c156033…` | **123** |

**The digest discriminates by value** — three distinct row sets, three distinct digests — so a monitor that pins
it can say *which state* it is looking at. **`gone` does not discriminate at all**: it reads **123** for both the
blinded anchor and a legitimate retirement, so it says only *that* something changed, never *what*. A monitor
should therefore **pin the digest for identity and read `gone` for magnitude**, and it must not expect either to
name a cause: **nothing in this record tells you which kind of change occurred, and this instrument emits no
signal that separates a blinded anchor from a legitimate retirement.** A reader who needs that distinction needs a
signal the tree does not currently produce. Neither reading is the exit code either: that comparison already
exits 1 for the new rows, so a reader who watches only exit status sees nothing at all.

---

## 6. Two findings that will not survive a clone

Process findings from the adjudication pass. 6.1's supporting artifacts are untracked; 6.2's engine is
tracked, so its measurement is re-runnable — which is why it is given with the instrument that produced it.

**6.1 A disagreement the diff tool cannot detect.** The reconciliation step that compared two independent
readings of the same citations keys its conflicts on **`(path, line)`**. A disagreement about *which file* a
citation belongs to therefore lands in two different keys instead of one conflicting key: the tool printed
`conflicts: 0` while a real contradiction existed. The instance was the session-query cell's `:43` / `:43-46` /
`:44-45` — the sweep bound those lines to `packages/session-query/src/file-backed.ts`, the human declaration to
`packages/session-query/src/index.ts`. **The source settles it for the declaration**, re-opened at `1ac091e`:

- `packages/session-query/src/index.ts:43` is `export interface SessionQuery {` — the declaration's lines are
  right;
- `packages/session-query/src/file-backed.ts:43-45` are `const FTS_TEXT_COLUMN_INDEX = 4`,
  `const DEFAULT_LIMIT = 20`, `const MAX_LIMIT = 100` — nothing to do with the interface.

Generalised: **a checker whose output looks like a clean sweep of a question it never asked.** `conflicts: 0` is
silent about a disagreement that changed the *key*, not the claim — the reconciliation tool itself is part of
this milestone's untracked working set, so a clone inherits the lesson and not the tool.

**6.2 A latent range hole.** The citation engine splits a file with
`readFileSync(abs, "utf8").split(/\r?\n/)` (`scripts/audit/verify-citations.mjs:54`), so a file ending in a
newline yields an array whose `length` is `wc -l + 1` — the final element is the empty string after the last
newline. The only bound test is `last > ls.length` (`:180`), which **admits `last === ls.length`**: a citation
one line past the end. What happens next is shape-dependent, and was measured in the code:

- a **bare** citation to that phantom line resolves, lands on `""`, and is reported `BLANK_LINE` (`:190`,
  `:200-213`) — caught, but misclassified as a blank line rather than an out-of-range citation;
- a **range** whose *end* is the phantom line passes **completely unchecked**, because only `ls[line - 1]` is
  inspected for content (`:190`) and the range's blank-line scan begins at `line` (`:205-209`).

**The measured zero — and the measured three.** The adjudication pass recorded **0 of 79** line-bearing
verdicts on existing paths exploiting it; that verdict set is part of this milestone's untracked working set,
so it is recorded as measured rather than re-derived here. Re-measured directly at `1ac091e` with an
instrumented copy of the engine (`scripts/audit/verify-citations.mjs`) over the citation set held by the
**tracked** audit data (`docs/audit/data/*.json`; the three citations below are
`docs/audit/data/2026-09-11-d3-codex.json:1541` and its `:2480`, plus
`docs/audit/data/2026-09-11-d3-grok.json:1402`; **8,367 citations, 7,936 resolved**), the two shapes separate:

- the **start-line** shape is unexercised — **0** citations resolve to the phantom final element;
- the **range-end** shape is **already in use** — **3** citations end exactly on it, and all three are
  **silently clean**: they appear in no problem list at all, which *is* the hole.
  `codex-rs/core/src/session/code_mode_warning.rs:1-27` (26 lines plus the trailing newline),
  `codex-rs/core/src/config/requirements.rs:1-187` (186 lines) and
  `crates/codegen/xai-grok-secrets/src/lib.rs:1-6` (5 lines) — each cited end is one line past the real last
  line of its file;
- the four `BLANK_LINE` problems (`packages/session-persistence/src/index.ts:254`,
  `packages/compaction/src/config.ts:99`, `packages/settings/src/index.ts:703` and `:1262`) are genuinely blank
  **interior** lines, none of them the phantom element, and the four `OUT_OF_RANGE` problems are real overruns
  the bound test caught (`packages/settings/src/index.ts:1250-1338`, *"file has 1275 lines"*, plus `:1316`,
  `:1338` and `:1365`).

**Two different things are "tracked" in that sentence, and only one of them carries the evidence.** The
*citations* are in this repository — the JSON files named above. The *files they point at* are not in it at all:
they resolve only through the machine-local reference trees named in the **untracked**
`scripts/audit/source-paths.local.json` (`.gitignore:57`), while the committed defaults
(`scripts/audit/lib-union.mjs:70-74`) point at `D:/agent-complete/…`, which does not exist on this machine. On a
machine without those trees the same three citations surface as `MISSING_FILE` — 740 citations already do at
`1ac091e` — so the three instances are what *this* workstation can see of a hole that lives in the tracked
engine: the finding survives a clone, the three witnesses do not.

So the honest form is **a zero on one shape and a three on the other — and the exploited shape is the one that
reports nothing.** A hole with a measured zero is acceptable only while both are on the record; this one is
recorded with a measured three.

---

## 7. A required sweep for any future behaviour-changing task

**A change that satisfies a plan can silently falsify an adjudication that lives in another artifact.**

Task 1's CLI change (`4ea5b5d`) restored the bare-launch usage error, which **reversed the premise** of the
allowlist's `noRow` entry *"CLI surface 2 — unknown subcommands not rejected"*
(`scripts/audit/reachability-allowlist.json:197-199`). Nothing in the process was watching that seam: the edit
was in `apps/cli`, the adjudication in `scripts/audit/`, and **no task's file list contained both**. The entry
has since been corrected in place (`:198`) and recorded as *reversed and superseded* rather than withdrawn on
its merits.

**There is no mechanical check for this.** Its shape is the class-5 anchor defect (§5) one layer up: a change
that is right in its own file invalidates a statement in another file that nothing re-reads. **Required sweep,
for every future task that changes behaviour:** re-open the `noRow` items and `entries` reasons that name the
symbols, files or commands you touched, and say in the task's report which ones you re-opened. A file list that
never contains both sides of a seam is the symptom to look for.

---

## 8. Trap 3: what `--seed-baseline` does to a CRLF worktree

Filed in its natural home as **trap 3** of §6 in `docs/handoff/2026-09-15-m2-reachability-gate-handoff.md`; the
measurements behind it are here.

`--seed-baseline` writes with ``writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`)``
(`check-reachability.mjs:1787`) — **LF bytes, with no EOL translation**. Measured at `1ac091e`: the worktree
copy of `scripts/audit/reachability-baseline.json` is **CRLF-only** (480 CRLF of 480 newlines on disk) while
**the committed blob is LF-only** (0 CRLF, 480 LF), under `core.autocrlf=true` and with **no `.gitattributes`**.
A seed therefore rewrites a CRLF file with LF.

**What that actually costs** — measured in a scratch repository with the same configuration, because the effect
is narrower than "a whole-file diff" and the difference is the trap:

- `git status --porcelain` reports the file **modified** (` M`) — and `git status` writes **nothing to stderr**
  (measured: 0 bytes), so the "modified" flag arrives with no explanation at all;
- the warning comes from the *diff* family only: `git diff`, `git diff --stat`, `git diff --numstat` and
  `git diff --quiet` each write a one-line warning to **stderr** — *"in the working copy of '…', LF will be
  replaced by CRLF the next time Git touches it"* — while the three content forms write **nothing to stdout**
  (measured: 0 bytes) and `--quiet` exits **0**. `autocrlf` normalises on read, so an EOL-only rewrite is
  invisible to a diff's *content* even though the worktree file differs from its blob on **480 of 480 lines**.
  The only signal is that stderr warning, which a `2>/dev/null` or a stdout-capturing tool discards;
- `git add` then clears the status and stages nothing, and `git add --renormalize` normalises only the
  **index** — it leaves the worktree file LF;
- a plain `git checkout -- <path>` **does restore CRLF** (measured) — *provided nothing refreshed git's stat
  cache for that file in between*. Once a `git add` has run, which is what a re-seed workflow does next, git
  considers the LF file clean, the checkout is a **no-op**, and the worktree stays LF; recovering CRLF then needs
  the entry invalidated — remove the file and `git checkout -- <path>` (measured).

So the trap is not "the diff you will see"; it is **a file that reports modified, stages clean and is
byte-unstable**, plus every byte-level comparison (worktree against `git cat-file blob`, or the CRLF-converting
`git archive` that M2's trap 2 already warns about) disagreeing for the whole file.

---

## 9. What this record does not establish

- **The classification's per-name judgements are not re-derived here.** The bucket *sizes* and the partition
  are measured (§2.1); the assignment of each of the 104 rows to T, B, C or ? is the adjudication recorded in
  the allowlist's dated entries, with its per-member evidence inline in those reasons.
- **The blocker owners are judged; the blocker sizes are measured.** What §3 measured is the work each blocker
  implies: 12 files across 7 packages for `createExecService`, one line for `WorkspaceRegistry`, one call site
  for `describeDirectory`, and zero precedent for the cross-package repoint.
- **§6.1 cannot be fully re-derived from a clone** — the reconciliation tool and the 79 verdicts belong
  to this milestone's untracked working set. **§6.2 can be**: the engine is tracked, and its numbers were
  produced by a copy of it instrumented to count `line === split-length`, with the counts needed to re-run it.
- **A zero from this instrument is not self-certifying.** §5 shows the gate's own blindness arriving as a
  falling count, and `--self-test` does not catch it: measured on the silent variant above, the suite still
  reports 36/36. The other two readings move, but **only a pinned digest identifies a state** — it takes a
  distinct value per row set (`c777795c…` / `6fa7863c…` / `6c156033…`) — while `gone` reads **123** for the
  blinded anchor and for a legitimate retirement alike, and is a count **only against the frozen 523-row
  baseline**, because a re-seeded baseline makes it 0 by construction. Pin the digest for identity, read `gone`
  for magnitude, and expect neither to name a cause (§5, §10).
- **Line-number rot.** Every `path:line` here was re-opened at `1ac091e`; a later edit above any of them moves
  it. The convention is the M2 record's trap 1: **label-primary with a dated line number**.
- **M65 did not touch the scanner, the baseline data, or the gate's behaviour.** The only change this record's
  milestone made under `scripts/audit/` is the pointer repaired in §11.

---

## 10. Reproduce it in five commands

```bash
node scripts/audit/check-reachability.mjs --self-test   # expect: 36/36 ok, exit 0
node scripts/audit/check-reachability.mjs --digest      # expect: c777795c…b24e
node scripts/audit/check-reachability.mjs --gate        # expect: gate PASS -- no new rows, exit 0
node scripts/audit/check-reachability.mjs               # expect: 466 ts files, 472 finding(s) + the tally
git show 08f30c5:scripts/audit/reachability-baseline.json > /tmp/b523.json
node scripts/audit/check-reachability.mjs --gate --baseline /tmp/b523.json
# expect: 115 baseline rows gone, 59 NEW rows, exit 1 -- and `gone` must stay 115 (§5)
# the pin is the point: the committed baseline was re-seeded to 472 on 2026-09-17,
# and `gone` against THAT baseline is 0 by construction -- it cannot show the blindness.
# pin the row-set digest as well: it identifies the state with no baseline at all
#   (c777795c = as committed, 6fa7863c = anchor blinded, 6c156033 = variant 2),
# whereas `gone` reads 123 for the last two alike -- magnitude, not cause
```

**Dated correction (2026-09-17, after M65 closed): four figures above have moved, and one of them
mattered.** The `@i-harness/feedback` package was deleted — 330 lines whose own source recorded that
*"the only consumer of feedback persistence is the SPA over the web host's HTTP routes — there is no
embedder seam to compose"*, i.e. a consumer M65 had already removed. Rows left the set, so the block
above is wrong for a reader running it now. **It is left as measured rather than rewritten**, per this
document's convention; this table is the correction. Measured at the tree that made the deletion:

| reading | at `1ac091e` | after the deletion |
|---|---|---|
| `--digest` | `c777795c…` | **`87f97ca1…`** |
| bare output | 466 ts files, 472 finding(s) | **464 ts files, 459 finding(s)** |
| `--gate` against the frozen 523-row baseline | **115** gone, **59** NEW | **120** gone, **50** NEW |
| `--self-test` | 36/36 | **36/36 — unchanged** |
| `--gate` against the committed baseline | PASS, no new rows | **PASS, no new rows — unchanged** |

**§5's pin is therefore corrected here, and the correction is the point:** §5 says of the frozen-523
comparison that *"`gone` rows — 115 here, and it must stay 115"*. **It is 120 now, and it must not be
expected to stay anything** — `gone` is a count against a FIXED baseline, so any later retirement of a
row the 523 held raises it. That is the ratchet working, not a defect, but it means **115 is a
`1ac091e` reading and not a constant**. The five rows are exactly the five `@i-harness/feedback` rows
the 523 baseline carried, measured by set difference against `git show 08f30c5:…`; **the other eight
feedback rows were *new* relative to the 523, so their removal lowers the NEW count instead** — which
is why NEW reads 50 and not 59. The decomposition reconciles: 64 new → 56 (−8 feedback, −1
`workspace#WorkspaceRegistry`, +1 `workspace#createWorkspaceRegistry`), of which 6 are allowlisted
(was 5), leaving 50 reported.

**What §5's argument loses, it loses honestly, and it does not lose its conclusion.** The table in §5
is explicitly scoped to `1ac091e` and remains a correct measurement *of that revision*. The
`gone`-vs-the-frozen-baseline reading is still the only reading that shows the blindness at all; what
the deletion changed is that **the number to compare against is whatever the frozen baseline yields on
the day, not a pinned 115** — which §5 already said in its own words ("a re-seeded baseline makes
`gone` 0 by construction", so a monitor must pin its baseline). **A monitor that pinned 115 rather
than the baseline would now read the deletion as blindness.** That is the trap this note exists to
close.

**One more thing this deletion exposed, recorded here because it is this document's own signature
defect arriving a second time.** Retiring the package made
`@i-harness/workspace#createWorkspaceRegistry` appear as a NEW row — it had been CLEAN, and the only
reason was **comment-masking**: the sole cross-file mention of that name anywhere in production was a
doc comment in the then-existing `packages/feedback/src/index.ts:208` (*"Registry over the coordinator
document store (the createWorkspaceRegistry shape)"*), which named it as a design precedent, not a
call. This is the mechanism baseline doc §7 item 4 records, and it is the second measured instance in
this milestone's own history. The row is adjudicated in the allowlist (dated 2026-09-17) as part of
the workspace package's frontend-contract class, **not** as a new orphan.

And to reproduce the §2.1 table without disturbing this tree: `git archive` each named revision into a
temporary directory and run the tool with `--root <that directory>`; the `1ac091e` copy must reproduce the
digest `c777795c…` exactly, which is what makes the row counts comparable.

---

## 11. The tracked pointer this record repairs

`scripts/audit/reachability-allowlist.json:126` — the deferral of `settings#SETTINGS_DEFAULTS` — cited *"a
DETECTOR defect recorded as R-2A-3 in this milestone's tracked handoff
`docs/handoff/2026-09-15-m2-reachability-gate-handoff.md`"*. **No such label ever existed there.** At `1ac091e`,
`git grep -n R-2A-3` matches only the allowlist itself (`:126` and `:198`), and a pickaxe over every commit
(`git log --all -S"R-2A-3" -- docs/handoff/`) returns nothing: the string was never in that path in any
revision. The M2 record is also explicit that it *closed* an instance of exactly this defect — its §4 lists
*"a takeover-document pointer to a record that did not exist"* among the things M2 repaired (`:119`).

The defect is recorded in **§5 above**, and both occurrences now point there: `:126` (the deferral's reason) and
`:198` (the *"same shape as the class-5 anchor defect"* generalisation, where `R-2A-3` was likewise a label
resolving nowhere). Nothing else in the allowlist changed; no row set, digest, baseline or gate behaviour was
touched, and `--gate` still exits 0 with the same 472 rows and the same digest (`c777795c…`).
