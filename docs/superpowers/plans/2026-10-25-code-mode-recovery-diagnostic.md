# Code Mode recovery 003 failure-only diagnostic

**Goal:** Preserve the first recoverable failure's stack and local owner state if the actual authenticated fixture reproduces it. A passing sample does not close003 or prove stability.

**Source:** `.superpowers/sdd/2026-10-25-native-consumer-identity-fixture/code-mode-003-diagnosis.md`. Historical product is `e68b4fc32fefbd98b4857ca70e2e72cf004f6f33`; exact failing test source is SHA256 `a45a7eafebd3ae41847437579885e839b67fb194f0b0553402215cfaaa50e775` in original003 evidence. No change to native helper300348/template334994 is needed.

## Constraints

- This is an isolated forensic branch, not shipping product implementation. Instrumented files must never be cherry-picked into MAIN as a fix. Preserve baseline and actual failure evidence; no provider/profile/network activity, no subagents, no release.
- Use a dedicated existing managed worktree with explicit root reservation. Protect its unrelated untracked artifacts. Product source before instrumentation must match the historical baseline; tests/config/workloads are controlled.
- One bounded named authenticated test run only. Do not retry until green or widen to a repeated native-job loop. A setup failure may be corrected once with the setup result preserved; a genuine pass leaves cause open.
- No added await, flush, snapshot, reconcile, source close, action, producer/guest restart, timer relaxation, or success-path catch/then stage. Preserve error identity/precedence and actual program control flow.

### Task 1: Capture first failure without changing healthy dispatch scheduling

1. Read the causal report and exact original003 source. Preserve original product/test hashes. Restore the exact003 test to the forensic checkout only; no final positive fixture or diagnostic async hook may be substituted silently.
2. Insert test-only synchronous capture in the existing FACT failure branches identified by the report: runtime observation catch before retainObservation, original output publication failure catch, terminal recovery catch, and managed-document refusal only if needed to distinguish its existing local flags. Capture bounded name/code/stack/cause and local cell/session/call identity plus status, finishing, recoveryRequired, terminalReceiptPending, pending receipts/items/projection, source counts and actual finished/closeRequested eligibility. Read only already-local scalar state; do not evaluate payload bodies or request a new state snapshot.
3. The diagnostic buffer is test-owned, bounded and never throws. Record only on an actual failure branch; no success-path promise hooks or state changes. Persist the buffer after the invocation/test has settled, including recursive child-run cause before its serialization to an error string. Use bounded recursion/entry/string limits and explain them. Controlled error-only instrumentation is not a new product logging contract.
4. Run the exact named authenticated case once with genuine coordinator, result owner, native jobs and child Code Mode. Record source, tool/runtime/dependency identity, command/cwd/isolated environment, timestamps/exit and cleanup. Source/trace absence is not proof a branch never ran unless the capture itself is verified installed. On an initial setup error retain it; do not claim behavior evidence.
5. On failure, compare first stack/state with durable order and original003. On pass, report that the single sample did not reproduce003; do not infer baseline-flake, solved, or safe automatic retry. If useful, recommend one deterministic original-owner failure barrier at a named site for a subsequent root-approved task; do not implement speculative retry/error-precedence changes here.
6. Preserve instrumented sources and results as a clearly labeled forensic snapshot/commit on this branch. Report the exact diff and why each inserted statement is failure-only. Restore no user/protected evidence. Root owns any later product fix and independent review.
