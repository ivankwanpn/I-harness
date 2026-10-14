# Context recovery persistence compatibility

Read-only, 2026-10-14. Desktop stays 0.1.12; no product/tests/scripts/Git/settings/live calls. Corrects earlier note: non-ignorable format-1 registration does not ensure nondestructive older-reader refusal.

## Decision

**Use Session format 2 for operational recovery and modern-reader preflight before repair.** An untouched reader with the existing newer-format gate refuses a v2 header before repair. An unknown non-ignorable event in v1 is refused only AFTER its repair can mutate source. Desktop and Session-format versions are independent.

Prefer new writable sessions v2 and owner-only v1→v2 upgrade before writable return. Keep cold v1 reads; no UI upgrades. Fence append/write-behind against operational-v1 writes. Avoid asynchronous upgrades in synchronous append/onAppend/enqueue.

## Exact source evidence

- `session-persistence/src/coordinator/load.ts:24`: load checks version :27, repairs :31, validates types :36; ownership is borrowed after the first read. `loadOwned` flushes outside gate :75–78, checks version :82, repairs :83, validates types :84. Unsupported events therefore encounter mutation first.
- `session-persistence-jsonl/src/index.ts:139` reads without mutation; `format.ts:63` parses complete prefix. `index.ts:158–171` rewrites torn tail/missing closers. `replaceSessionFile` :14 syncs temp, renames, best-effort syncs directory. Backend repair is mutating.
- `session-persistence/src/format/validation.ts:28` gates headers; :44 gates type names only. Add operational payload-version validation. `format/registry.ts:14` upgrade chain lacks v1→v2 migration.
- `core-session/src/events/types.ts:246` sets current format 1. `serialization/jsonl.ts:17` accepts exact current version only; this separate pure import/migrate surface needs backward v1 support.
- `coordinator/ownership.ts:38` session gate is non-reentrant. `coordinator/mutations.ts:27` write-behind writes join it; :84 updateMeta joins it. Calling coordinator flush/updateMeta from inside the gate can deadlock.
- `coordinator/mutations.ts:56` current-format default can be overridden by following caller meta spread. `coordinator/types.ts:49` optional replaceEvents preserves header and cannot upgrade format.
- `session-persistence-jsonl/src/index.ts:199` updateMeta temp/rename lacks fsync: insufficient durable upgrade fence. Create :111 also lacks sync; header replacement needs its own barrier.

## Minimal architecture and ordering

Add pure `preflightSessionFormat(version, events)`: supported positive integer format, known/non-ignorable complete records, supported operational payload version/shape. Preserve ignorable events; no drop/renumber/write. Validate migration output. Unknown payload versions refuse even for registered types. Torn last line is not committed; unsupported complete prefix refuses without mutation. Interior corruption remains outside this repair.

Load: initial preflight, borrow lease, reread/preflight before repair; hold through output validation. LoadOwned: outside-gate flush, lease, preflight, repair, revalidation. Snapshot: pure read/preflight/migrate; no lease/repair/upgrade/auth/client.

Register identity v1→v2 migration preserving seq/references/metadata. Context/recovery requires format≥2. Pure imports accept v1/v2; memory normalization is not disk upgrade. Reject updateMeta/create format downgrade.

Add optional explicit backend capability:

```ts
upgradeSessionFormat?(id: string, expected: number, target: number): Promise<SessionMeta>
```

Compare expected header, durably upgrade before resolve, accept already-upgraded state, reject unexpected/newer versions. JSONL synced temp/rename must preserve raw body bytes/metadata. Unsupported capability allows v1 snapshots but refuses writable upgrade. No concrete Session SQLite backend exists here; future support needs equivalent transactional durability.

Owned v1 acquisition:

1. Quiesce writer producers before assembly publication; reject deleted admission; flush pending write-behind OUTSIDE session gate.
2. Enter gate, acquire/retain lease, reread/preflight. Check required upgrade/rewrite capabilities BEFORE mutating repair.
3. Perform permitted structural/semantic recovery; persist canonical events with replaceEvents if needed. Preserve strict seq invariant failures. No model operation starts here.
4. Call BACKEND upgrade directly inside gate; await durable result and verify format 2. Return writable v2 only afterward. Failure returns no writable session; v2 header without new recovery event is valid/retryable.
5. Retain writer lease; release only newly acquired lease on acquisition failure.

AdoptOwnership/direct append/write-behind need the same internal `ensureWritableFormatUnlocked` fence, calling backend methods directly under their existing gate. Fence DISK format before ordered event batch append. Existing `SessionWriteBehind.startWrite` (`write-behind.ts:121`) restores failed batch to pending; preserve this and avoid separate duplicate batch owners. Never await coordinator flush/updateMeta inside gate.

Dynamic upgrade can occur in first operational write callback: under-lease preflight, durable header upgrade, append/sync. Same fences/failure retention apply. It avoids unused upgrades but adds version ambiguity/marker checks. Prefer eager upgrade; core-session append stays synchronous.

Flush before model call; durable v2 header precedes recovery marker. Upgrade/save failure permits no retry/durable-success claim and proves nothing about tool execution.

## What older binaries can and cannot guarantee

V2 protects the shown coordinator load/resume header gate in untouched v1 readers, including torn/open tails. New preflight protects updated readers from unsupported event/payload records. Neither controls old code that directly invokes backend repair/append/updateMeta without format checks; old metadata-mutating APIs currently have no version gate. Do not promise universal immutability against arbitrary old processes. Cross-process safety also depends on honoring existing leases; lock-disabled writers cannot guarantee it. Windows directory fsync is best-effort, leaving filesystem-specific power-loss rename limits.

## Owned checkpoint binding identity

Task2 `token-meter/src/projection/measure.ts:73–80` bindingFingerprint hashes only protocol/providerId/modelId/expectedModelId. It does not identify endpoint/options/config. Keep its meaning; add owner-provided bindingConfigFingerprint and coverage.

Existing pure sources:

- Durable modelSelection: `session-persistence/src/coordinator/types.ts:23`, read through coordinator.profile.
- Loaded settings get/getSectionRevision("llm"): `settings/src/storage/contracts.ts:38–44`. `_revision` persists through `single-store.ts:56,80,194` and `layered-store.ts:63,93,137`. Manual edits/template/catalog changes may retain revision; counter alone is insufficient.
- `provider-runtime/src/directory/profile.ts:6` providerView folds template/route configuration; :74 runtimeProfile composes without API key; `provider/src/catalog/context.ts:52` computes capabilities/window/cap without inference. Endpoint/template options/max-token field/cache/usage/modality/selected row are available.
- `provider-runtime/src/types.ts:40` SessionModelBinding has no config identity. `selection/resolve.ts:62–86` resolves auth before client construction. Do NOT call resolveModel to validate cold UI checkpoints. `session-executor/src/service.ts:450` currently calls bindingFor; cold identity requires separate metadata seam. Desktop executable producer is `desktop-gateway/src/host.ts:180`; rebind publication is `service.ts:474`.

Add pure `describeModelBindingMetadata(selection, loadedSettings, providerView/catalog)` returning selection/protocol/window/cap/reasoningEffort/configFingerprint/identityCoverage. Canonically hash effective NON-SECRET endpoint and request-affecting options, selected model capabilities/caps, max-token field/cache/usage policy and identity schema version; combine content with relevant section revision. Exclude display labels/wait/retry-only fields when they do not affect context. Reuse this pure resolution in executable resolver and metadata inspector.

Never persist secrets/raw URLs/headers/options; sensitive opaque configuration yields partial coverage and invalidates restored calibration. Redaction or hashing low-entropy secrets cannot establish safe equality. Trusted host may supply safe stable opaque identity; otherwise unknown. Endpoint-affecting account routing needs non-secret identity. UI reads no auth/clients.

Wire optional metadata field through binding plus `SessionServiceOptions.modelMetadataFor(sessionId, meta)`. Desktop implements from loaded configuration only. Rebind publishes metadata with accepted executable binding. Checkpoints persist non-secret identity tuple/digest/coverage, projection/input fingerprints and usage. Restore accepts only complete matching identity AND projection; mismatch/unknown invalidates calibration while preserving recovery-required facts. Child role/explicit summary bindings need their OWN metadata, never parent's.

## Focused verification, cost, risk

Extend existing files; no test/script split or execution here. Cases: unsupported complete event/payload + torn tail yields zero repair/replace/update and byte-identical source; v1-gate fixture refuses v2 before repair; cold v1 read unchanged; owned upgrade preserves seq/meta/body; missing capability refuses before repair; failed upgrade retains pending batch/no model call; crash after header before marker safely reloads; no gate→flush/updateMeta deadlock; all append paths refuse operational-v1 writes; endpoint/options/manual/catalog changes invalidate checkpoint; UI identity reads call no auth/client builder.

Cost: preflight/reread, one O(session bytes) header upgrade, metadata seam. V2 blocks old resume. No Desktop bump/E/I redesign.
