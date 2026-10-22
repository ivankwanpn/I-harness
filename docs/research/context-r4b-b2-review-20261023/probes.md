# Task2 independent-review probes — unchanged product source

2026-10-23. Runtime observations requested in `task-2-probe-brief.md`, including the later canonical-rewrite and literal publication-only probes. No fix, product edit, maintained-test edit, HEAD change or index change was made. This report supplies evidence for the fresh reviewer/root; it does not assign severity or accept the implementation.

Product HEAD before/after: `50db21c16cc8a4add4b2ff4bf2d6c7c0d4757c58`.

New ignored scratch/evidence root: `.tmp/r4b-b2-review-shortwrites-20261023/`. Existing `.tmp/r4b-b2-20261023/` evidence was untouched. One focused command executed the cases sequentially:

```text
pnpm exec tsx .tmp/r4b-b2-review-shortwrites-20261023/probe.mts
```

Exit0. No setup failure occurred. The command ran from PowerShell through the new root's `run.ps1`; raw stdout is `run.log`, command/UTC/exit/source binding is `run.meta.txt`, complete before/after source manifests are `before.sha256`/`after.sha256`. Each case has a JSON record, complete actual write trace and retained physical store directory. No suites, sleeps, fake commit responses, live providers/user data or subagents were used. All coordinators were closed; no background job remains.

## Source and index binding

Both manifests cover all241 files in the three affected packages' `src` and `test` trees, including the modules/tests introduced in Task2. Their SHA256 values are identical:

`03B85DA1B3F709C0C52EAE1E0473A9C6A40B64C50312CE52169DB2617A254DBF`

This equals the final implementation qualification/commit binding. HEAD is unchanged. The Git index **file** SHA256 before/after is also identical:

`8DDA786C01D18999EE0D2C2B28DCDFF1B63AC1FA0CF902767FDAF55D53FF810D`

The raw metadata labels those fields `INDEX_TREE_BEFORE`/`INDEX_TREE_AFTER`; despite that label, the runner obtains them with `Get-FileHash` of `git rev-parse --git-path index`, not `git write-tree`. No Git tree/index write command was used. `git --no-optional-locks status --porcelain` was unchanged and clean.

## 1. Short writes followed by stale source or Stop

The script constructs the real public coordinator/JSONL backend with actual exclusive ownership. A wrapper on the real FileHandle prototype calls the original native `write` for at most11 bytes of the selected stage/header buffer. Immediately after the first actual11-byte write resolves, and **before returning that write's promise to product code**, it either makes `assertCurrent` throw or aborts the signal. It continues to record native writes; it does not suppress guards, inject successful receipts or change product I/O methods.

All four cases began with no target, stage or publication file (`before={}`). Initial writes below exclude later explicit recovery. “After flip” excludes the first11-byte write that triggers the change.

| Case | Selected initial write calls / bytes | Additional writes / bytes after flip | Physical state after original bootstrap | Original returned outcome |
| --- | --- | --- | --- | --- |
| stage + stale |169 /1850|168 /1839| Complete1850-byte `.stage`; target absent | `blocked`, phase=`header`, reason=`unknown`, actual known manifest token |
| stage + abort |169 /1850|168 /1839| Complete1850-byte `.stage`; target absent | `blocked`, phase=`header`, reason=`unknown`, actual known manifest token |
| target + stale |72 /791|71 /780| Complete791-byte target header plus1852-byte original stage; no completion frame | `blocked`, phase=`dependencies`, reason=`source-changed` |
| target + abort |72 /791|71 /780| Complete791-byte target header plus1852-byte original stage; no completion frame | `blocked`, phase=`dependencies`, reason=`unknown` |

Thus actual write calls continued after the await at which currentness/Stop changed. The eventual blocked result did not stop the remaining writes of that selected file. The stage cases stopped before creating the target at a later guard; the target cases wrote the complete header and stopped before completion issuance.

For all four cases:

- `inspectBootstrap` returned `reserved`, with a real manifest digest and `needsConfirmation:true`.
- Resume with the same stale/aborted guards made **zero additional write calls** and preserved every observed stage/target byte/hash. Stale resumes returned blocked/source-changed; aborted resumes returned blocked/unknown. Passive reads/sync confirmation are distinct from the recorded write count.
- A separately labelled resume with fresh guards completed `ready` under the same invocation, permitting clean coordinator shutdown. Those later recovery writes are segregated as `fresh-recovery` in the per-case trace and are not counted above. Initial snapshots are retained in the JSON records even though the live scratch store subsequently completed.

The unchanged source location is `packages/session-persistence-jsonl/src/backend/bootstrap-header.ts`, `continueFile`: `before()` precedes the asynchronous complete-write loop; the remaining loop iterations call `h.write` without repeating that guard. The evidence here reports the resulting writes rather than prescribing a fix.

Raw details:

- `stage-stale.json`: stage SHA256 immediately after original call `6dc6d5d0c37ea439c25284077867d2d6b94b557526a5e2aff24226b29c5dd4be`.
- `stage-abort.json`: stage SHA256 `6636b81e161bba928268dd5a4adf5d84cba9bf56e58229d7227ec77740e35ff8`.
- `target-stale.json`: header SHA256 `06181702ad5a8a27e47f112e36400889163c3c81d68177a53a8dcf5458c2e608`.
- `target-abort.json`: header SHA256 `20bec43ad9d49276c139187abf9953db4857a0e73ec7ac7e8f7d7abcc3a8ad2e`.

A normal short-write positive used the same wrapper with no stale/abort flip:169 stage writes persisted1852 bytes, bootstrap returned ready, inspection returned ready, and reentry returned already-ready. It confirms that the wrapper supports real complete writes and successful qualification. See `stage-normal.json`.

## 2. Real same-events canonical rewrite after genuine B2 readiness

After restoring the native write method, the script created a nonempty semantic target through the real B2 coordinator. It had seedLength2 and3 events: seed manifest, seed group and completion. It reached ready with retained original stage. The script obtained events through normal `backend.read` and passed that exact returned array to `backend.replaceEvents(id, events)`.

Observed sequence (`canonical-rewrite.json`):

1. Before rewrite, the2787-byte target had two deterministic frames: `bootstrap:probe-canonical-rewrite:seed` (firstSeq0/count2) and `bootstrap:probe-canonical-rewrite:complete` (firstSeq2/count1). Original target SHA256 was `30c955bc89353109ebf9bea24978d6cc45f3933555ae0de217f2176593554bc3`.
2. `backend.replaceEvents` **succeeded**. The target became2395 bytes with one random-ID frame `5a441e13-1187-4bf5-85f1-52be0c137a6f` (firstSeq0/count3), containing the same three event types. The retained1963-byte stage was unchanged. Rewritten target SHA256 was `0d682d018f7488f1445cfed0d778b0d69cde3dc40e138ddbd765916084f7ba5f`.
3. Subsequent normal `backend.read` threw `bootstrap-incomplete`, code `SESSION_BOOTSTRAP_INCOMPLETE`.
4. Subsequent ordinary title `backend.updateMeta` also threw `bootstrap-incomplete`, code `SESSION_BOOTSTRAP_INCOMPLETE`; the original title remained unchanged.
5. `resumeSemanticTarget` separately returned blocked/unknown, phase=`completion`. No bytes changed during those later attempts.

Ordinary readability and qualified original-receipt adoption are separate observations. R-B-24 requires exact original deterministic frame evidence for a bootstrap receipt, so refusal to recreate those receipts after a random-frame canonical rewrite is distinct from the observed failure of normal read/title-update after a successful ordinary rewrite. This report does not conflate the two or select severity.

## 3. Literal matching publication-only retained artifact

This is explicitly a constructed retained-artifact negative, **not** a claim that the normal happy path naturally creates this cut.

The script wrote only the exact invocation-derived name:

```text
target.jsonl.bootstrap-6fb2d24662886da8d950cb2492ff5b8ad200060f18faa31775e0ca81c5e56de1.publish
```

It contained the19 literal bytes `partial-publication`; no target or stage existed. SHA256 was `8954293f514cd20df4f2f9932d0666cf1a5fb048a2afa83ec0e9b7421f5e8f0f`.

Observed sequence (`publication-only.json`):

1. `inspectBootstrap(invocation)` returned `kind:'absent', needsConfirmation:false` despite that exact retained publication file. Inspection preserved its bytes and sole-file inventory.
2. `bootstrapSemanticTarget(originalNewTargetPayload, guards)` returned `ready`. It created a1411-byte target and1694-byte original stage while leaving the same19-byte `.publish` file present and byte-identical.
3. Normal coordinator close preserved those files; no recovery cleanup was performed.

The raw per-case inventory records names, sizes, SHA256 and first11 bytes before inspection, after inspection and after bootstrap. Unknown retained publication bytes were therefore observable on disk while inspection reported absence. Root/reviewer will determine the contract finding and any correction.

No product correction, maintained regression addition, broad rerun, Git/index mutation or self-acceptance accompanies these probes.
