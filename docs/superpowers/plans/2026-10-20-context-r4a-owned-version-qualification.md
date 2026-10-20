# R4A — Owned Session version qualification

> **For agentic workers:** Use subagent-driven-development. Codex root coordinates continuous execution; the sole implementer and a fresh independent reviewer use GPT6.1Sol. No recursive delegation. A task handback is an internal review boundary.

**Goal:** Qualify the actual owned Session8/9→10 upgrade, append, close and fresh reopen path, and rejection of incompatible retained-result facts before any source mutation. Correct obsolete test expectations without inventing a new product failure.

**Architecture:** The original JSONL backend owns header migration and framed bytes. The original persistence coordinator preflights under ownership before repair/upgrade/append. Current10 retained-result validation stays in core-session. This task adds proof at those existing boundaries; no replacement migration engine or result store is planned.

**Tech stack:** Existing TypeScript, Node24, Vitest, actual JSONL persistence/coordinator and isolated copied Gateway packages. Offline controlled fixtures only.

**Status2026-10-20:** Accepted through test commitcdb55a4b and delivery1755ee07 after fresh independent PASS and root source/copy/fixture verification. [Acceptance](../../research/2026-10-20-context-r4a-owned-version-acceptance.md) preserves VERSION-01, original failures and precise scope. Production source unchanged; continue native producer outcomes.

**Predecessor:** [Accepted result consumers](../../research/2026-10-20-context-r4a-a4b-display-acceptance.md). Related contracts: [R4A retained results](2026-10-18-context-engine-r4a-retained-results.md) and [remaining A4–A6](2026-10-19-context-engine-r4a-completion-handoff.md).

## Scope and fixed rulings

- Existing checkout `D:/I-harness-main`, branch `codex/v0.1.13-development`, clean root acceptance91e90aeb. Product0.1.13-rc.1, Session10, original decomposition27/43 unchanged. No push/merge/tag/release, installed user data or live provider.
- This is one coherent qualification task, expected to modify tests only. Actual current code already has preflight-before-mutation and header-only framed migration. If a new negative exposes a product defect, identify its genuine original-owner behavior and obtain root's concrete design ruling before expanding this unit. User approval is already present for the redesign; root's internal ruling is not a permission prompt.
- Literal predecessor8/9 must remain literal; current10 and future11 are distinct fixtures. Derived search schema2 and auxiliary task/state versions1/2/3 are unrelated.
- Keep raw source body bytes, journal metadata, unknown metadata extensions, model selection extensions, unresolved generation reservations and legacy unknown outcomes. Upgrade must not mint execution results, child marker/authority, new result descriptors or provider calls.
- Structural export can construct a valid current fixture, but a decoder-only pass cannot substitute for an actual owned open/append/fresh reopen.
- Negative fixtures first decode as valid current10. Then alter **only the header formatVersion** to8/9, preserving the body. This deliberately incompatible fixture checks refusal, not a claim about old writer output.
- Refusal must happen before source repair, header upgrade, replace or append. Instrument the real backend methods by counting calls before delegation. Do not mock ownership/decoding with expected answers. Lock metadata for genuine acquire/release is not falsely classified as a source-body write.
- Existing tests that still target9 or reject10 have obsolete assertions. Preserve their failing output and classify as test-contract migration, not a new regression or meaningful RED for a product change.
- New characterization controls already passing on unchanged production source are qualification evidence. No manufactured RED. Any genuine source fix requires discriminating before/after evidence.
- Keep source/file boundaries small; tests/scripts are excluded from the decomposition task. No global numeric replacement, time-bound inflation, removed safety oracle or audit exemption.
- VERSION-01 root ruling after actual package-suite failures: also correct intended-current fixtures/oracles in JSONL `jsonl.test.ts` and `generation-reservations.test.ts`, and persistence `attribution-format4.test.ts`, `native-witness-format5.test.ts`, `fork.test.ts`, `persistence.test.ts`, `ownership.test.ts`, `coordinator-order.test.ts`. The current mock read/repair and missing-seq callback fixture are not predecessor upgrade tests; make them current10 while preserving getter order, receiver, repair and lease assertions. Keep literal predecessor0–9, future99, literal5 mount/crash bytes and generation total-cap9 unchanged. Do not add fake upgrade capability. This is a same-owner test-contract expansion, not a product fix.

## Files and interfaces

Read original owners:

- `packages/session-persistence/src/coordinator/load.ts`, `writable-format.ts`, `format/validation.ts`, `managed/` as necessary.
- `packages/session-persistence-jsonl/src/index.ts`, `backend/format-upgrade.ts`, `backend/fact-journal.ts`.
- Core Session current-format validation, `fromJSONL`, `toJSONL` and genuine fact fixtures.

Modify existing tests:

- `packages/session-persistence-jsonl/test/format8-predecessor.test.ts`
- `packages/session-persistence-jsonl/test/context-format.test.ts`
- `packages/session-persistence-jsonl/test/replacement-journal.test.ts`
- `packages/session-persistence/test/conversation-format.test.ts`
- Add narrow `packages/session-persistence-jsonl/test/retained-format-ownership.test.ts` and fixture helper only when it keeps the cases clearer.
- Preserve `packages/core-session/test/fixtures/format8-journal.ts` as a genuine literal8 source. A separate literal9 fixture may derive from its legacy body, with an explicitly qualified old unknown result; do not relabel the original fixture globally.

Existing public APIs are sufficient:

```ts
createJsonlBackend(root)
createSessionCoordinator(backend, { lock: { enabled: true } })
coordinator.openManagedDocument(sessionId)
document.metadata.admit({ type: 'session/title', title, messageSeqs: [], source: 'fallback' })
coordinator.loadOwned(sessionId)
coordinator.close()
fromJSONL(raw)
toJSONL(session)
```

Do not change product APIs solely to make a test convenient.

## Task 1 — Qualify current ownership and literal predecessor contracts

- [x] Run the four existing affected test files sequentially on frozen source; save original stale-oracle failures and any other failures separately.
- [x] Update only current-target expectations9→10 and literal future10→11. Preserve literal6/8/9 source data and original journal/unknown/zero-replay assertions. In `replacement-journal` correct the actual current-header downgrade discriminator, asserting the replacement really changes bytes before expecting refusal. In `conversation-format` correct its actual future10 fixture and stale title as well as header expectations.
- [x] Exercise literal8 and9 with explicit and automatic upgrade through real JSONL/coordinator ownership. Preserve exact original body, original journal and metadata. Append one real managed metadata record, close fully, construct a fresh coordinator and reopen from disk. Confirm the original events/body prefix, one append, unresolved reservation without new disposition, legacy unknown result without invented new envelope/outcome, no child marker and zero fetch/model execution. Opening an owner is not itself authorization to execute pending work.
- [x] Exercise current10 valid retained facts through the same owned append/reopen route. Assert original ref/revision/execution/media metadata survives. Do not rely only on a structural in-memory roundtrip.
- [x] For each new retained slot—ordinary tool/result, nested code/result, emitted code/output, subagent/end envelope/revision, job/status retained result—first validate its current10 framed fixture. Alter only header8 or9, then use actual owned entry. Assert clear version refusal, zero calls to repair/upgrade/replace/append, and exact unchanged source bytes. Cover literal future11 the same way; no downgrade or “repair” into validity.
- [x] Preserve existing cold-snapshot zero writes, held/rejected upgrade with exactly one pending batch, no invented event disposition, fenced uncertain recovery, metadata extension fidelity and literal6 journal-byte cases.
- [x] Run the directly affected suites and types sequentially at frozen source. Reuse accepted task/state version tests when relevant; do not rewrite or rerun unrelated A3/MCP/browser/renderer gates.
- [x] Build a fresh isolated Gateway package copy and run the actual owned backend/coordinator qualification against the copied public owners, including fresh reopen and incompatible-header refusal. Record source→copy hashes, internal package edges and the exact fixture import edits. Do not call this packaged IPC/installer qualification.
- [x] Self-review, commit coherent tests/necessary approved fixes, seal source-stable receipts and evidence, write delivery and return to root for fresh independent review. No product writes after handback.

### Concrete negative control

```ts
const currentRaw = toJSONL(validCurrentSession);
expect(fromJSONL(currentRaw).formatVersion).toBe(10);
const newline = currentRaw.indexOf('\n');
const wrong = JSON.stringify({
  ...JSON.parse(currentRaw.slice(0, newline)),
  formatVersion: predecessorVersion, // literal8 or9
}) + currentRaw.slice(newline);
await writeFile(sessionPath, wrong);
// Call-count wrappers delegate to the actual backend if unexpectedly reached.
await expect(coordinator.openManagedDocument(sessionId)).rejects.toThrow();
expect(mutationCounts).toEqual({ repair: 0, upgrade: 0, replace: 0, append: 0 });
expect(await readFile(sessionPath, 'utf8')).toBe(wrong);
```

Assertions must distinguish the intended version failure from a malformed fixture or missing module. Include the valid current counterpart; a malformed event that fails every version proves nothing about upgrade safety.

## Evidence and acceptance

Use `.superpowers/sdd/2026-10-20-context-r4a-owned-version-qualification/` for this plan's ledger/brief/report, and a fresh `.tmp/context-r4a-owned-version-20261020-implementation/` for raw evidence. Do not overwrite previous task evidence.

Each run records executable/arguments/cwd, source digest before/after, start/end, exit and raw output. Commands/tests are sequential; freeze product and test source during each run. At final seal preserve source manifest, copied package map, fixture transformation map and evidence inventory. Scope build/library-copy claims honestly; no claim of live provider, 100MiB fan-in, whole R4A or release qualification.

Preserve initial root-filter discovery contamination and overlapping receipts12/13 as non-qualifying setup/process evidence; subsequent package-root runs must explicitly wait for completion. Generated copied files such as WSL `worker/manifest.json` have their actual generator/build provenance and output hash recorded separately from source-identical package files; a generated file is neither a missing-source waiver nor a fabricated source copy.

The next units remain native producer outcomes and explicitly authorized artifact paging, followed by remaining A5/A6/R4B/C/R5/R6. Root continues after this independent acceptance without asking the user to resume.
