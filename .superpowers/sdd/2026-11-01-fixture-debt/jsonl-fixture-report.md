# JSONL fixture repair candidate (incomplete)

Source checkout: C:/Users/inkik/.codex/worktrees/ih-regression-qa/I-harness-main; base c8b3bfb9ef5f87d25ffc51af1dce2e5c9d5a5923. Read R6 implementation-report.md and source-review-20261101.md in absolute D:/I-harness-main/.superpowers/sdd/2026-11-01-r6-streaming. Original connected-full-c80607d9d2f0436ea490f051ad7714b6 failures are preserved, not waived.

Both fixtures now compose the original JSONL backend with TaskTransition and the actual subagent task storage contract. Representative TASK_TRANSITION_UNSUPPORTED red reproduced and green passed. Fact journal factory mock supplies stable vi.fn delegates around actual implementations; fault injection uses mockImplementation so constructor-owned public method identity remains intact. Original held owners and production validation are retained. Literal legacy alias format5 remains unchanged.

Evidence under absolute D:/I-harness-main/.superpowers/sdd/2026-11-01-fixture-debt:
- representative-red-a637af49df28438a92b4e1e6135eaae9: one expected failure.
- representative-green-e000bd22dcd0420a8d1cac9743609537: one pass.
- fixture-files-7027378568c642cf8f09ff8876ffb3cf: constructor-only migration, 19 pass/15 fail.
- stable-delegates-ed2f78ab1fe245c88768373d8ae7e4ff: 26 pass/8 fail; confirm mock was initially on incorrect factory and subsequently corrected.
- corrected-confirm-c14ab94fe5c144d08a905c1f5d798095: corrected public fixture, 1 pass/5 fail.
- corrected-types-ed3327273146472bb30c6ce782937a33: final candidate JSONL types exit0.

Remaining work: legacy load fixture still spies on original backend.repair and therefore trips original descriptor guard; move this observation to genuine implementation boundary. Structural fork receives nonready outcome requiring diagnosis. Public passive recovery and direct revoke/close expose Task14 transition owner lifecycle: Ownership claim retired from ownership.ts:180 through task-document-transition.ts:303 held owner, bootstrap-header.ts scope/hasTrackedHeaderDebt and backend-factory.ts hasHeaderDebt. Direct close and repeated revoke controls time out. Do not weaken assertions or replace actual owners. Parent ROOT informed for product scope decision. No product edits, skipped tests, dependency changes, broad gates or MAIN edits.

This candidate is not green and not complete. Independent review remains necessary after remaining repairs.
