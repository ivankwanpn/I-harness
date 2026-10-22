# B1 independent-review offline probes — 2026-10-23

This is an execution receipt for the exact A1/A2/B1/B2/C/D controls in `task-1-review-resume-20261023.md`, plus root's subsequently requested E format10 write/upgrade control. It is not acceptance of B1 or connected B, and contains no implementation change.

## Source identity and execution boundary

- CWD: `D:/I-harness-main`.
- HEAD before and after: `bf4c0aa5b24f3755d8d0e685fd161b57e6133a27` (product `886045296831cb1aea438f4d1a0999dd27efe5d3` plus root rulings).
- Initial and final `git status --short`: empty before this report was written.
- Node `v24.15.0`; pnpm `12.3.4`; PowerShell; Windows.
- Fresh scratch root: `D:/I-harness-main/.tmp/r4b-b1-review-probes-20261023`. Creation refused to proceed if that directory already existed. All fixture stores, scripts, logs, scalar results and before/after bytes are retained there.
- SHA256 captured before product runtime and after both runs for all 131 Git-tracked files under `packages/core-session/src`, `packages/session-persistence/src`, `packages/session-persistence-jsonl/src`, plus the literal ready fixture `packages/core-session/test/fixtures/format11-seed.ts`. `source-before.json`, `source-after.json`, and `source-comparison.json` show **131 checked, 0 changed**.
- Only this agent ran product runtime for these controls, sequentially. No product or maintained-test edit, no fix, commit, agent dispatch, live provider/account/session, model/auth invocation, or prior evidence mutation. Existing evidence, old logs and predecessor qualification are preserved. The real fork baseline remains RED pending B2.

Read the resume instructions first, then the review brief, implementation report, contracts and relevant current source. The generated review diff is 5,164 lines / 384,482 characters; this execution receipt does not substitute for the independent reviewer's full diff review.

## Actual commands and exits

Both commands ran from `D:/I-harness-main`, through the repository's existing tsx dependency. Output was redirected to a new retained log; `$LASTEXITCODE` was saved in the corresponding command JSON and propagated by the shell.

| Command | Exit | Command/exit receipt | Full output |
| --- | ---: | --- | --- |
| `pnpm exec tsx .tmp/r4b-b1-review-probes-20261023/probes.ts` | 0 | `01-command.json` | `01-probes.log` |
| `pnpm exec tsx .tmp/r4b-b1-review-probes-20261023/probe-e.ts` | 0 | `02-command.json` | `02-probe-e.log` |

The script emits one JSON line per control and also writes `results.json` / `results-e.json`, including full thrown stacks. Exit0 means the requested controls executed without setup failure; it does **not** mean the observed product behavior passed its contract. All expected product refusals/errors were captured as outcomes.

Initial source/environment command created the fresh directory, obtained `git ls-files` for the source scope, used `Get-FileHash -Algorithm SHA256` per file, and wrote `source-before.json` / `environment.json`. Final command repeated those exact path hashes, compared all values, captured `git rev-parse HEAD` / `git status --short`, and wrote `source-after.json` / `source-comparison.json`; both shell commands exited0. Some earlier read-only discovery commands referenced guessed absent paths (`packages/core`, `packages/session-jsonl`, `packages/session-store-jsonl`, `conversation/seed.ts`/`shape.ts`) or supplied wildcard paths directly to rg on Windows. Those searches reported path errors and were corrected to the real paths or rg `-g` filters. They did not execute a fixture and are not behavioral evidence or runtime setup failures.

## Scalar observations

| Control | Verified setup | Actual outcome |
| --- | --- | --- |
| A1 | `createSession`; actual `append(turn/start)`, `append(user/message text='safe')`, `append(turn/end)`; ordinary export control is `seed`; then selected text replaced by enumerable accessor | Export **`seed`**, getter reads **1**, emitted content `["getter text"]`. |
| A2 | Same supported three-event source; `turn/start.seq` replaced by enumerable accessor returning original **0** | Export **`seed`**, getter reads **19**; emitted safe input remains present. |
| B1 | Genuine `createJsonlBackend(scratch).create` plain current11 metadata; backend read/project succeeds with **0** events/**0** items; no semantic reservation | Public `backend.append(id,[literalReady.events[0]])` **resolves undefined**. Bytes **252 → 1062**, changed. Subsequent public read **rejects `TypeError: Invalid semantic seed`**. Read changes no bytes. |
| B2 | Genuine backend current11 reservation; supported `backend.replaceEvents` installs the complete literal ready array; backend read succeeds with **3** events and projection has **2** items | Extra literal seed-group with physical `seq:3` appended outside the reserved prefix **resolves undefined**. Bytes **2873 → 4345**, changed. Subsequent read **rejects `TypeError: Invalid semantic seed`**. Read changes no bytes. |
| C | Fresh format11 `createSession`; existing empty `events` array redefined `{writable:false,enumerable:true,configurable:true}`; actual internal bootstrap receives literalReady header/events and `current()=>true` | Throws **`TypeError: Cannot assign to read only property 'events' of object '#<Object>'`**. Before header absent/events empty; after header is the complete semantic reservation (**header identity changed**), while **same original events identity**, still **0** events, still nonwritable. Partial header installation is observable after throw. |
| D | Each actual unavailable-retention ResultEnvelope independently passes the full existing `validateResultFact` and independently exports `seed`. Combined source is closed: **9** real appended events, **1** projected exchange, **2** calls/results | Combined export **`seed`**; returned seed also passes public `validateSemanticSeed`. One exact immutable json ref has **two** `dependency-catalog` uses, counts **1** and **2**. Both result dependencies refer to artifact slot **0** with their conflicting counts. No artifact body I/O. |

For A1, the exact machine-readable emitted content is `["getter text"]`. Each invocation is the actual `exportConversationSeed(source,{kind:'anonymous'},{kind:'all'})` API. A1's pre-mutation control also shows that failure is not a malformed initial turn fixture. A2 has no pre-mutation export beyond the real append operations.

B2 is not an incomplete-prefix setup: it uses the backend's real supported whole-event replacement to provision all three literal records, then verifies actual backend read and public projection before the attempted append. Only the extra record's physical seq changes from1 to3 to address the new append position; the group remains literal ordinal0, which is invalid outside the reserved prefix. Before/after `.jsonl` copies and store files remain available for both B controls.

## Code paths explaining the observations

### A1 selected payload descriptor

`conversation/seed-export.ts:15–17` selects then captures. `conversation/seed-capture.ts:43–46` supplies the accessor-rejecting `captureSelectedData` through `renderConversationItems`. However `conversation/render-items.ts:37` constructs the selected input message using direct `event.text`, bypassing the `payload(...)`/`readConversationPayload` capture used for images and other payload fields. The getter return is already a string by the time the final seed DTO is validated (`seed-export.ts:24`). This is the actual path that emits `getter text`; the observation is not inferred solely from source inspection.

### A2 scalar descriptor before boundary derivation

`seed-selection.ts:50` invokes `createSemanticSourceConversationIndex` before boundary derivation, but the selected source shape path is `validation.ts:40–44` → `events/conversation.ts:47–51` → `bootstrap-validation.ts:31–35`. The latter returns immediately for ordinary turn records. `events/conversation.ts:94` also returns for non-explicit records without rejecting their seq accessor. Index address/history processing and then `seed-selection.ts:17`'s direct `seq:event.seq` therefore read the turn accessor; actual counter19/export seed establishes the remaining R-B-15 gap. This does not question the deliberate R-B-10 exclusion of discarded payload bodies.

### B1/B2 append publication versus later read

Public JSONL `index.ts:89–126` validates each incoming event shape, reads/validates the **existing** journal at115, addresses the incoming records and encodes them at117, then writes and syncs. It does not validate candidate existing+incoming history before that write. `backend.read` at147 reaches `core-session/src/serialization/fact-journal.ts:88`, which validates complete history only after the bytes have been published. B1 then fails `bootstrap-validation.ts:53` (seed record with no reservation); B2 fails `bootstrap-validation.ts:69` (seed record outside fixed prefix). These are public backend append observations; this receipt does not silently redefine their contract or propose an implementation.

### C atomic standalone installation

`managed/memory-bootstrap.ts:11–13` accepts this pristine extensible typed Session; it checks ownership/header/event emptiness but not installable property descriptors. Candidate capture and staging succeed at14–21 and the freshness guard is true at22. `session.header=candidate.header` at23 succeeds, then `session.events=candidate.events` at24 throws. The result shows header-only partial installation, before index publication or observer loop.

### D exact catalog count consistency

`conversation/seed-capture.ts:57–65` deduplicates refs by id/revision and checks the entire immutable ref, but adds distinct uses using canonical full-use equality; count1 and count2 are distinct keys. `seed-codec.ts:82–85,209,216–228` validates positive counts, correct codec and an exact set of used descriptors, without requiring a single consistent catalog count for the same ref. The two independently valid source envelopes therefore produce one table row with contradictory catalog uses, contrary to `task-1-contracts.md:122`'s explicit count-consistency requirement.

Exact D artifact row (no artifact body exists or is read in this offline fixture):

```json
{
  "ref": {
    "version": 1,
    "id": "ctxv1_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "revision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "codec": "json-utf8-v1",
    "encodedBytes": 10,
    "contentDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "completeness": "complete"
  },
  "origins": [
    {"origin":0,"seq":5,"part":"result"},
    {"origin":0,"seq":6,"part":"result"}
  ],
  "uses": [
    {"kind":"dependency-catalog","count":1},
    {"kind":"dependency-catalog","count":2}
  ]
}
```

## E format10 writable compatibility (additional root request)

Four separate scratch JSONL targets contain literal format10 headers and genuine core-encoded fact journals: `legacyPrefixDigest(0,new Uint8Array())`, valid five-field journal metadata, and `encodeFactBatch` over an ordinary closed turn with input. Each target passes actual `backend.read` as **version10 / 3events**, plus public projection as **1** item. Each coordinator uses actual exclusive ownership `{lock:{enabled:true}}`; coordinator close runs in finally. The current11 metadata control uses genuine `backend.create` rather than the literal old header.

| Actual operation | Outcome | Bytes before → after | Disk version afterward |
| --- | --- | ---: | ---: |
| `backend.upgradeSessionFormat(id,10,11)` | Rejects `Error: unexpected session format upgrade or downgrade` | 787 → 787, unchanged | 10 |
| `coordinator.ensureWritableFormat(id)` | Same rejection | 789 → 789, unchanged | 10 |
| `coordinator.openManagedDocument(id)` followed by intended `document.metadata.admit({type:'plan/mode',mode:'on'})` | Open rejects with same error; metadata admission **not reached** | 801 → 801, unchanged | 10 |
| `coordinator.updateMeta(id,{title:'changed title'})` | Same rejection; title remains `original title` | 781 → 781, unchanged | 10 |
| Current11 control: real open then metadata admission | **`committed`**, backend reads version11 / **1** `plan/mode` event | Successful control (not an upgrade fixture) | 11 |

All four failures originate at `packages/session-persistence-jsonl/src/index.ts:222`: the public upgrade wrapper admits expected versions `[1,2,3,4,5,6,7,8,9,target]`, and target11 omits10. The leaf `backend/format-upgrade.ts:29` explicitly supports framed10. Real coordinator `writable-format.ts:15` reaches the rejecting wrapper; managed open reaches it through `load.ts:133`; metadata header update reaches it through `mutations.ts:108`. This is an actual valid old-format write barrier, not a missing-journal fixture failure. The separate current11 managed control proves supported ownership and ordinary metadata payload configuration.

The read-only `coordinator.snapshot` reports an in-memory Session formatVersion11 for each old target because existing `format/validation.ts:75`'s `buildSession` constructs the current format. This was recorded in results, **not** counted as a disk upgrade or a successful writable migration. Saved before/after bytes cover snapshot plus the operation and remain byte-identical; subsequent genuine backend read still returns10.

## Evidence map and limits

- A–D fixture/execution source: `.tmp/r4b-b1-review-probes-20261023/probes.ts`.
- E fixture/execution source: `.tmp/r4b-b1-review-probes-20261023/probe-e.ts`.
- Complete scalar/returned results and thrown stacks: `results.json`, `results-e.json`, `01-probes.log`, `02-probe-e.log`.
- B byte receipts: `B1-before.jsonl`, `B1-after.jsonl`, `B2-before.jsonl`, `B2-after.jsonl`.
- E byte receipts: `e-<operation>-before.jsonl`, `e-<operation>-after.jsonl` for all four operations.
- Store directories, environment and full before/after source hashes are retained under the same scratch root.

There were **zero runtime setup failures** in either command. No broad suite, sealed runner, predecessor runtime or real fork baseline was rerun. The maintained predecessor test's provisioning/portability concern is left to the independent source review and existing pinned-reader evidence; no simulated predecessor, skip, or old-log overwrite was introduced. Root owns consolidated findings and any future implementation authorization.
