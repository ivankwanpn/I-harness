# Observed saved-settings load implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans for this bounded packet. A fresh full-range spec/quality review follows.

**Goal:** Let the real Desktop host and settings edit path validate and load the same saved document bytes, while exposing an explicit observed snapshot for the forthcoming instruction-policy host.
**Architecture:** Extend the existing SettingsStore queue/read owner, preserving normal tolerant load compatibility. A strict observed load returns a same-byte source stamp and validates supplied instruction data before normalization; Desktop supplies its existing execution-policy validation against an isolated immutable document value, then consumes that exact loaded state without a second read.
**Tech Stack:** TypeScript, existing Node file/crypto helpers, SettingsStore, Desktop gateway and Vitest.
**Spec:** docs/superpowers/specs/2026-10-23-v0.1.13-integrated-delivery.md Task3; existing accepted instruction settings contract; IC-B host source audit `.superpowers/v0113-integrated-delivery-20261023/instruction-host-final-contract.md`.

## Global constraints

- Product0.1.13-rc.1 and Session format12 stay unchanged. No remote push/merge/tag/release, real user profile/credential/provider access, recursive agents or pure decomposition.
- New agents use GPT-6.1 Sol. One writer/runtime per assigned checkout; root owns MAIN. Package-CWD Vitest maxWorkers2/minWorkers1, suites sequential.
- Preserve existing SettingsStore.load, writes, revision guards, migration and layered-store behavior. Do not rewrite W1/W2, add polling, another settings store, or a public raw-document mirror.
- No new instruction watcher/main request integration in this packet. Its real shipping consumers are Desktop startup and withDesktopSettings; IC-B uses the resulting strict read contract afterward.
- Every claimed test has a retained command/CWD/time/numeric exit and source binding. Preserve RED/setup/oracle failures. No missing log is recreated or described as present.

## Files and single ownership

| File | Responsibility |
|---|---|
| packages/settings/src/storage/single-store.ts | Queue the new read, validate/normalize/publish atomically in memory, return source snapshot |
| packages/settings/src/storage/contracts.ts; src/index.ts | Only observed-load types required by real callers |
| packages/settings/src/storage/observed-read.ts (if useful) | Cohesive byte-read/decode/immutable validation helper; no separate cache/store |
| packages/desktop-gateway/src/settings-file.ts | One shared Desktop document-value validator and existing locked edit consumer |
| packages/desktop-gateway/src/host.ts | Startup observed load; remove separate validate-then-load file reads only |
| packages/settings/test/observed-load.test.ts; packages/desktop-gateway/test/observed-settings.test.ts | Causal source/queue/publication and real host/locked edit controls |

The rest of Desktop host, service, assembly, CLI and current-context owners are read-only. Existing tests may be read/reused; scope expansion needs root's named causal ruling.

## Frozen API and read semantics

```ts
export interface ObservedSettingsLoadOptions {
  validate?: (document: Readonly<Record<string, unknown>>) => void
}
export type ObservedSettingsLoad =
  | { kind: 'loaded'; settings: Settings; stamp: { kind: 'present'; sha256: string } }
  | { kind: 'missing'; stamp: { kind: 'missing' } }
// A method on the existing SettingsStore, not a new store:
loadObserved(options?: ObservedSettingsLoadOptions): Promise<ObservedSettingsLoad>
```

- Capture the optional validator function before entering the queue. Read the selected filename exactly once as bytes; use existing stampBytes on those bytes and parseDocumentTolerant on their UTF8 text. Comments accepted by the existing store remain accepted here. Do not use a second stat/read to attest the parsed data.
- Reject malformed JSON/nonobject document, ENOTDIR, unreadable input, invalid supplied instructions, or invalid migration metadata. Validate raw supplied instruction fields before normalization can erase malformed values. Absent fields remain defaultable. Rejecting does not publish, clear last-good state, change revisions or mark a previously unloaded store loaded.
- Invoke the optional validator once against an isolated recursively immutable JSON-data copy, never the raw object that will be published. It must not mutate the saved projection or source stamp. A validator throw, including undefined, remains a rejection and leaves the store unchanged; do not log the raw document or thrown private data.
- After all validations succeed, publish using the same existing normalize/revision owner and return a detached settings snapshot plus same-byte stamp. A caller mutating the returned settings cannot mutate store state.
- Only ENOENT yields kind:missing. If this store has never loaded, initialize its existing native defaults/empty raw/revision state once (so the actual locked edit path does not perform another tolerant read); do not manufacture a present stamp. If already loaded, preserve the entire last-good state/revisions. The missing result has no settings field, so consumers must explicitly decide first-run defaults versus unavailable later policy. The future policy host owns its seen-present distinction.
- Ordinary load() keeps its current tolerant fallback behavior. set/reset/migrateInstructions keep their queue and persistence semantics. This method does not claim protection against unobserved external writes after the read; it only eliminates validation/load double-reading and attests the exact read bytes.

## Task 1 — actual saved read and Desktop consumers

- [ ] **Causal RED:** add a real temporary comment-bearing settings document valid under SettingsStore with nondefault execution/instruction settings. Through current createDesktopHost and withDesktopSettings, demonstrate that JSON.parse validation wrongly rejects it before reaching the work. Retain that actual behavior failure separately from new-method contract tests; a missing import is not the behavioral RED.
- [ ] **Observed read RED:** cover good state followed by corrupt JSON, invalid explicit instructions and non-ENOENT read failure. Require rejection with no defaults publication, unchanged get()/revision and exact once read. Add first missing and later missing controls; existing load() must still return its documented tolerant defaults.
- [ ] **Implement minimum read path:** reuse the existing queue and publish owner. A helper may decode/read one buffer and return parsed/stamp data; it must have no independent state. Use a JSON-data freeze helper only locally where necessary; do not broaden public APIs beyond the types/method above.
- [ ] **Validator and queue controls:** inject a controlled read barrier on the real file-read seam, not a substitute SettingsStore. While a read is held queue an actual set/reset; prove operation order and that validation/publication uses the captured bytes even if the external file is atomically replaced after the read. The source stamp must equal an independent SHA256 of the exact captured bytes, including comments, not normalized JSON.

```ts
expect(observed).toMatchObject({kind: 'loaded', settings: {instructions: expectedPolicy}})
expect(observed.stamp).toEqual({kind: 'present', sha256: createHash('sha256').update(capturedBytes).digest('hex')})
await expect(store.loadObserved()).rejects.toBeDefined()
expect(store.get()).toEqual(previousSaved)
expect(store.getSectionRevision('instructions')).toBe(previousRevision)
```

- [ ] **Desktop value validation:** consolidate the existing pure document checks in settings-file.ts as validateDesktopSettingsDocument(document). Keep validateExecutionSettings behavior and existing sandboxMode/approvalMode/full-access consistency rules; no weakening of configured execution validation. Do not read a file inside the validator.
- [ ] **Startup consumer:** create the same selected SettingsStore first and call `await settings.loadObserved({validate: validateDesktopSettingsDocument})` once. A fresh missing profile uses that store's explicitly initialized native defaults. Remove only the old validateSettingsDocument read/JSON.parse followed by settings.load sequence. The settings path and all existing credentials/provider/session construction remain as before.
- [ ] **Locked edit consumer:** inside the existing provider lease, create the original store and call the same observed method/validator before work(store). The original lock and finally release remain intact; no second tolerant load. Validate comments, malformed JSON/instructions, unknown execution values and missing profile through this actual path.
- [ ] **No validation swap:** controlled file replacement after the captured read cannot make work/host receive an unchecked second document. Test the value actually used by the host/work, not just a read counter. A thrown validator leaves work uncalled and the lease releasable; later valid retry succeeds through the same normal entry.
- [ ] **Error/data controls:** validator receives frozen isolated input, returned settings are detached, errors/diagnostics expose no fixture credential string, and explicit globals[] stays distinct from absent globals. Migration provenance and revision fields survive validation/publication. Do not erase unknown unrelated settings fields or change write behavior.

## Verification and review

- [ ] Run package-CWD targeted RED/GREEN with `pnpm exec vitest run test/observed-load.test.ts --maxWorkers=2 --minWorkers=1` in settings, and `test/observed-settings.test.ts` in desktop-gateway. Retain every command/exit and the exact causal assertion.
- [ ] On frozen sources run the affected settings suite (whole package is justified by the common read queue), focused existing Desktop agent-settings/model-retry/settings-watch-close/host-close controls identified by actual changed callers, and settings/Desktop gateway typechecks. Explain any known baseline failure with actual evidence; do not call a failing gate green.
- [ ] Verify Desktop startup/edit tests use actual host and store owners over temporary profiles. No live provider requests or user's real settings. Cleanup joins watcher/service/lock resources and tests do not leave native processes active.
- [ ] Save final source copies and SHA256, HEAD blobs and full BASE..HEAD. Commit only owned files, write task-1-report.md in this plan's root SDD workspace, stop writes for a fresh GPT-6.1 Sol full-range review.

## Root self-review

The method is a narrow variant of an existing store read, not another store. Missing first-run defaults are explicit and do not overwrite loaded last-good data; comments, same-byte validation, source stamps, strict supplied-policy checks and original write queue are covered. The real Desktop consumers eliminate the old two-read path. CLI settingsPath threading, live watch-policy owner, request/producer pins, read targets and instruction UI remain later IC-B work and are not claimed by this leaf dependency. Root has already authorized continuous implementation; no new confirmation is required for this reversible scoped work.
