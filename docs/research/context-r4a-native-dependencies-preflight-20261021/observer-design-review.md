# Scoped review of root's selected observer design A

2026-10-21. Reviewed `observer-design.md` against the original storage, policy, tools, SDK, Desktop, Gateway and CLI entry owners. No product/test changes, tests, Git or runtime processes. Only this requested review file was written.

**Disposition: design A is coherent; add the one P2 caller mapping below before dispatch.** No P0/P1 contradiction, authority bypass or required lifecycle redesign was found. This review accepts the deliberate explicit-witness query contract and does not reopen option B.

## P2 — Enable the explicit v2 opt-in at the real CLI server composition too

The RPC section names actual Gateway opt-in, but `apps/cli/src/index.ts:760–761` also mounts the genuine `service.readResultPage` into `createSdkServer`. Once v2 opt-in defaults false, leaving this actual composition unchanged makes it advertise only1 and causes the SDK's required preflight to reject `viaCatalog` there, even though its underlying shipping reader implements the repair. This is a caller mapping omission, not a reason to infer support from arbitrary custom callbacks.

Add explicit v2 opt-in beside the real CLI `readResultPage` binding as well as Gateway. Keep custom callbacks default1. Extend the existing actual CLI protocol control at `packages/sdk/test/result-page-cli.test.ts` for advertisement and witness dispatch/preflight, preserving ordinary v1/downgrade controls. If CLI witness transport is intentionally deferred instead, root must state that limitation explicitly rather than claiming all actual capable hosts advertise2.

## Implementation boundaries to preserve

- The combined host callback must retain the actual frame `owner/ref/source` and apply direct catalog-fact visibility when **verified** `visibleVia` is present, before any same-owner shortcut. Merely calling existing `authorizeResult` on the catalog would bypass rewind through its owner shortcut; root's explicit rule correctly forbids that. Source-only checks and membership validation may be ordered within the internal helper; do not call the unchanged combined frame authorizer before verification and treat its expected visibility denial as a storage failure.
- Under artifact `mutate`, use internal validation/read helpers, not reentrant public `readResult/readExecResult/grant` calls. The existing artifact mutex serializes those public methods. The design's committed catalog identity can be verified through bounded operation/pin metadata without reading its body or taking the mutex again.
- Immutable companion publication must compare an existing keyed record before calling the general `atomicJson`, which can replace different destination bytes. The selected design already requires conflict refusal; the general helper's atomicity alone does not enforce immutability. Preserve byte-identical retry and C1 when C2 is pending/refused.
- Direct service raw/native read helpers also need to enforce native-target/JSON-witness semantics; the transport parser alone cannot protect lower direct callers. The model tool must reject `viaCatalog` on its legacy `refId` branch rather than allowing the legacy service to ignore the extra member.
- Pin-missing companion cleanup needs its own idempotent path before the current early ENOENT return in `releaseDocumentPin`; reusing that early return unchanged misses the specified interrupted cleanup case. Named document identity and rooted path checks remain required. Companion cleanup never changes real remaining-pin body ownership.

## Scope of held-read claims

The current Gateway rewind entry uses `fence.run` (`desktop-gateway/src/host.ts:441`), so a real rewind can change closed facts while a result page is held. Archive/delete management uses `exclusive` and drains registered work; a test must start the management operation, observe its fence, release the page and then join management, rather than awaiting management completion before releasing the reader. The existing service close path similarly joins readers after synchronously revoking availability.

Two source/current-fact checks prove the required denial when the actual change remains in effect at the post-read check. They do not, on their own, prove detection of an arbitrary revoke-and-restore cycle entirely between checks. Preserve existing monotonic close/revoke lifetimes, and label the concrete persistent-policy-change/real-rewind control accurately. If stronger ABA detection is intended by “read lifetimes stay monotonic,” root must identify an actual original policy/view generation or cancellation owner; do not silently add an unrelated authority epoch in this repair.

Once the CLI mapping is incorporated, the specified trusted scope -> committed original catalog -> pin-owned membership -> verified host witness -> current direct fact/source policy chain is ready for implementation. Product acceptance still depends on the actual controls, exact negative boundaries, source manifests and independent review; this note does not replace them.

## Finding closure and final readiness

**Final scoped disposition: PASS — ready for the authorized product writer.** Re-read the corrected `observer-design.md`: its RPC section now explicitly opts in both actual Gateway and `apps/cli/src/index.ts` compositions and names the existing CLI test. The sole P2 mapping finding is closed. The text also incorporates existing-record comparison before `atomicJson`, lower direct-service witness validation, internal non-reentrant helpers under `mutate`, and the concrete held-policy/draining/ABA claim limits discussed above.

No remaining concrete design blocker or additional finding. This is readiness under root's selected A contract and reported new-contract RED, not product verification or a reopening of the API choice. This closure performed only read/search inspection and appended this note; no product/test edits, tests, runtime processes or Git work.
