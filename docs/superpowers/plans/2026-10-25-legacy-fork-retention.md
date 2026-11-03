# Legacy fork retention owner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Root dispatches one implementer and a separate full task reviewer.

**Goal:** Preserve selected legacy result retrieval through semantic bootstrap using the existing storage owner, with correct original recovery, revocation and quota behavior.

**Architecture:** B1 supplies typed semantic boundaries, B2 remains bootstrap receipt authority, F0 supplies actual binding lifetimes, and the accepted L0 ContextStore owns bytes/membership and the one shared mutation queue. New bounded transfer metadata records commit references without copying complete descriptors or archived payloads.

**Tech Stack:** TypeScript, Node filesystem/SQLite, existing core-session and persistence/B2/F0 APIs, existing fs-lock and Vitest.

**Spec:** docs/superpowers/specs/2026-10-25-legacy-fork-retention.md. Read its closed interfaces, namespace, phases and L1-01..21 in full; these are the exact task requirements.

## Global constraints

- One connected owner task, GPT-6.1 Sol, no recursive agents. Only one writer/runtime in its assigned managed worktree. Root reviews and integrates the complete BASE..HEAD.
- Product0.1.13-rc.1, Session12, SemanticSeedV1 and original result body/owner-array formats remain. No public fork caller rollout, model/producer/input replay, second storage/quota/receipt owner, arbitrary total-ref/descriptor cap, push/tag/release or installed profile/provider operation.
- Use genuine L0 ownership and original cleanup; actual B2/F0/project controls, no fake successful ports. Pure decomposition stays deferred; new functionality uses cohesive modules.
- All failures/setup/oracle corrections and source-bound raw receipts remain. Sequential package-CWD Vitest uses --maxWorkers=2 --minWorkers=1; no suite repetition without a changed owner or unresolved concern. No reachability exemptions/reseed or synthetic production consumer.

### Task 1: Complete the connected legacy transfer owner

**Files:** Spec's context-output ownership, codec, page, disposition, query and private ledger modules; the narrow core-session seed-retention companion; existing artifact/quota.ts and ContextStore.diskBytes for the one corrected inventory; L1-13 core bootstrap facts type/validator/entry plus persistence coordinator bootstrap-types.ts, bootstrap.ts and a cohesive preparation-facts helper/forwarding wrappers; focused tests and actual B2/F0 fixtures. L1-13 permits only optional preparation-facts forwarding in Gateway context-runtime.ts's existing wrapper; it does not enable the strict-recipient option or roll out public fork callers. Do not modify SDK, Desktop, CLI or other Gateway production callers. Any public metadata field not specified by the spec needs a root ruling before implementation.

**Interfaces:** Implement the exact LegacyCommitment/Binding/Page/Root/Applied/Observation/Capture and ContextOutputService methods in the spec. Reuse actual createWorkspaceMutationOwner/WorkspaceMutationTurn/LeaseRetirement, continueAtomicJson/confirmAtomicJson and B2 BootstrapTargetPreparationRequest. Core's typed ref shape is Extract<SessionEvent,{type:'context/result-ref'}>['ref']; never import ContextOutput into core-session.

- [ ] **Step 1: record causal baseline failures.** Construct the actual completed VISIBLE/rewound HIDDEN/FUTURE source, genuine legacy capture, real B1 seed and B2 target. Preserve inability to establish bound original transfer/cold retrieval before the new owner. An import/missing-method compilation failure is setup evidence, not a behavior RED. Add independent literal row/commitment expectations and actual OS storage controls.
- [ ] **Step 2: implement phase1.** Closed codecs, streaming full-ref commitments, structural typed retention selection, actual-manifest binding and bounded page graph. Validate source/target at each await. Exercise huge metadata, page/count/EOF/anchor boundaries and10001 observations without a total-ref cutoff.
- [ ] **Step 3: implement phase2.** Actual original owner-array merge/readback, funded reserves/predecessor and deterministic terminal slots, application confirmation, clear/delete/TTL integration and the single inode-aware inventory. Exercise missing/unknown/conflicting publication, interrupted rename, fullquota cleanup, other-owner preservation and cold original disposal. Do not collapse partial publication into success or roll back over newer owners.
- [ ] **Step 4: implement phase3.** Strict observed retrieval, cycle-free private membership, cold startup/index recovery and lifecycle joins. Real B2 reaches READY for nonempty legacy with empty managed closure, and for mixed managed catalog/member plus legacy closure. After source.clear/close and cold reopen, read/search VISIBLE and deny HIDDEN/FUTURE/pre-READY. No original source hooks on passive recovery.
- [ ] **Step 5: original warm/Stop/cleanup controls.** Stop after a real partial page, retire the old callback, then continue only from the same actual source witness under fresh F0/project scopes. Verify prefix identity, zero producer/payload compile on continuation and one original target/application. Changed/lost/closed source and cold partial work refuse honestly. Cached B2 request under passive guards cannot issue missing header/seed/completion. Close joins original file handles/attempts, preserving failures.
- [ ] **Step 6: fixed-source verification.** Run new owner tests and affected full context-output/core-session suites, persistence bootstrap/F0 integration and affected types, then the existing executor mixed-retention native/quota and original-close consumers. Keep original semantic-fork failure as F1-C debt; do not change it to pass prematurely. Record exact source/command/cwd/exit and every discrepancy. No packaged release build here; root owns actual public-caller and final package gates.
- [ ] **Step 7: commit and report the full range.** Report exact scopes, record versions/paths, meaningful RED/GREEN, unsupported filesystems/platform limits, phase-specific source stability, source-only versus actual runtime controls and remaining F1-C obligations. Root creates a full review package and independent Sol review; do not self-declare the version or public fork complete.

Use controlled temporary roots and real current owners. Follow the spec's ordered steps rather than adding a speculative framework. If a concrete test reveals a missing interface, send the exact cause and smallest proposed root ruling, while continuing independent authorized work. Tests/scripts are not size-decomposition targets; avoid new monolithic product modules.
