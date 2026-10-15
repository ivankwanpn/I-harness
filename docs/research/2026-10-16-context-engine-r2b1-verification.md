# ContextEngine R2B1 verification — effective input and payload identities

BASE `38a2da0bb76a1d69382a9d25ac010f2d3320a8c6`; initial implementation `610ecf32d3e4a6896aa08083d9d4991a5935d188`, corrected HEAD `72a98ef5706ae48e2a052cb5747ed2ac51843288`, branch `codex/v0.1.13-development`. Product stays0.1.13-rc.1. **Fresh initial review found two Important issues; original reviewer scoped re-review now PASS for specification and quality, both resolved with no new Critical/Important findings.** This accepts the corrected R2B1 scope, not the initial source or release readiness.

Plan: [projection identities](../superpowers/plans/2026-10-16-context-engine-r2-projection-identity.md). Local report/review/ledger: `.superpowers/sdd/2026-10-16-context-engine-r2-projection-identity/`; receipts `.tmp/context-r2b1-identity/`. Root inspected the full report, gate counts, final/baseline exit ledgers and exact audit comparison. The review independently checked source/receipts and ran only two focused fake-transport probes for missing coverage.

## Implementation scope

All six built-in routes generate versioned semantic/pricing identities and exact HTTP-body or typed SDK-command identities. Only recorded adapter-created cache insertions/wrappers are normalized; caller data with matching field names stays identity-bearing. Final effective raw options, reasoning, ordered blocks and actual model participate. Neutral custom clients retain explicit neutral-only coverage. Bedrock reports a command estimate, never measured HTTP bytes. Typed encoding distinguishes bytes/arrays/lookalike objects and snapshot-preserved Dates.

The private prepared handle lowers HTTP data once, measures original and cap derivatives independently and sends the same serialized bytes it measured. Built-in legacy calibration shapes rotate by semantic shape plus pricing version; the old public serializer/no-argument meter stay unchanged. Main budget/recovery/telemetry and summary preparation use selected final-candidate facts. Main selects at most one derivative with existing formulas; summary retains its5% margin/defaults/bounded splitting. A cohesive prepared-summary leaf reduced summarizer.ts from337 to276lines. Single-policy activation is still R2E, accepted-execution lineage/pure probes R2B2.

## Initial evidence and review findings

The initial nonduplicated affected gate set has **804 passing scenarios**: token-meter44, seam119, Responses156, Chat74, Anthropic81, Gemini87, Bedrock66, core-session22, core-agent42, compaction32, corpus81. Named affected package/e2e typechecks pass. Real wrong-owned-cache-path and frozen-derivative mutations fail intended assertions. Six routes exercise schema depths2000/6000 through controlled preparation/identity/send; this is not every native/SDK response or deep persistence path.

Retained intermediate failures include an initially nonexistent seam test path, a corrected owner-ID fixture, neutral summary's omitted9 fixed tokens, distinct SDK Dates colliding before their typed-tag fix, and an initial CLI verify command using the wrong flag. Corrected receipts do not erase those attempts. The actual ledgers are baseline-exits.log/final-exits.log, not receipts.txt.

Fresh review found:

1. Anthropic response completion still fingerprinted an earlier pre-lowering body. The actual signed-response probe invoked stateful schema toJSON twice and produced a prefix that did not match the transmitted schema. The correction must use lowered frozen semantic data with only proven cache normalization.
2. Gemini spread final generationConfig into an object, collapsing string `x` and object `{"0":"x"}` into equal semantic/shape identities despite different payload IDs. Non-record final representations must remain distinct or be rejected explicitly.

Both are actual adapter prepare/stream reproductions with no backend assumptions. Initial804 cases did not cover them. Original implementer supplied fix1, and the original independent reviewer accepted the correction scope after inspecting source, RED/GREEN receipts and the new copied-runtime probe.

Initial exact audit remains406→406, no added/removed rows, digest `6f6445aeb2059dacfca8a81879184fb39aeee38a607ddd7b5bcb4f24ca6f05a7`;82/82 audit selftests and82 reachable packages/0cycles. No dependency/manifest/lock change or baseline reseed. Initial fresh Gateway242-package own-runtime identity smoke and CLI5839.0KiB verification pass, but did not exercise the two review counterexamples. The correction required its own targeted packaged boundary probe, detailed below.

## Correction evidence

Fix1 range610ecf32→72a98ef5 changes only Anthropic client/prefix hashing, Gemini final-value description and their regression tests. Anthropic retains the prefix from its lowered execution body after proven cache normalization; the existing public legacy hash helper preserves ordinary prefix bytes while remaining stack-safe. Four actual signed-response cases cover changing/throw-on-second serializers, generated cache on/off, original→cap64→original transports and exactly one source serialization. Gemini keeps string/object/null/array identities distinct and strips output cap only from records; cap64→32 equality and thinking4096 remain verified.

The affected nonduplicated fix scope is **273 passing scenarios**: Anthropic85, Gemini89, core-agent18 and corpus81, plus affected package/e2e types. These overlap the initial804 and must not be added to it as another full-suite total. Actual intended RED receipts precede both corrections. Exact406-row audit/digest is unchanged; no graph/dependency/export change, so82-reachable/0cycle evidence remains source-equivalent.

Fresh `.tmp/context-r2b1-fix1-gateway` ships242packages and runs its own copied runtime:4signed cases/12signed transports/one serialization per case,6Gemini representations and cap64/32 controls,18explicit fake sends and no external network. The reviewer confirmed all three corrected product files match their copied-runtime counterparts by SHA256. The earlier CLI receipt remains evidence for its original source and is not presented as correction verification. Initial failing review and scoped passing addendum remain together in task-1-review.md; detailed fix receipts are fix1-* and task-1-fix1-report.md.

## Retained limits

Whole verify:all remains historically **FAILED/incomplete**. Prior phase baseline failures and27/43 original decomposition count remain. No live provider/account/count tests, installed app/profile changes, new worktree, version increase, merge or release. CLI36 dynamic TypeScript import warnings and optional-platform notices remain disclosed.

Content identity does not prove account continuity, native replay permission or exact remote tokenization. Remote references/incomplete inputs and image/native uncertainty retain their declared coverage. Provisional v1 calibration can still retire a sample while probing a different shape; R2B2 explicitly replaces that lifecycle. R2C/D validators, R2E policy unification, R1D/R3 publication and attempts, R4 artifacts/delivery and R5/R6 qualification remain separate unfinished gates.
