# @i-harness/sandbox-policy

Session sandbox policy resolution and immutable execution authority snapshots. Import supported APIs from `@i-harness/sandbox-policy` and shared contracts from `@i-harness/sandbox`.

`compileExecutionPolicy({ mode, owner, authority })` returns a frozen `CompiledSandboxPolicy`. It snapshots the owner, mode, authority revision/kind, primary root, all authority roots, write roots and reference roots. Nested owner and root collections are frozen. Its SHA-256 fingerprint covers canonical policy content, including authority roots in every mode. Input mutations cannot update an already compiled policy.

The three supported modes are `read-only`, `workspace-write` and `danger-full-access`. An unbound authority supplies its workspace root; a bound authority supplies the primary root, additional roots and references. Revoked, unavailable and malformed authority states refuse compilation. In `workspace-write`, authority roots are the permitted write roots. Other modes carry authority roots without adding write roots. Readability is recorded as `"caller"`.

`assertExecutionAuthority(prepared, current)` checks both fingerprints against canonical content and requires unchanged policy content. Revision, owner, mode, root membership or reference changes refuse admission, including removal of a secondary authority root under read-only or full-access modes. Revoked/unavailable current authority refuses when the caller tries to compile its current snapshot.

For execution admission, compile the approved snapshot once and pass it to `launchExecution` from `@i-harness/exec`. The trusted validator reads current authority, compiles the current snapshot and calls `assertExecutionAuthority` against the prepared policy. Admission validates before probing and after asynchronous preparation; the backend receives a callback for its final commit fence. Admission performs no automatic policy refresh or backend retry. A changed authority requires a new authorized attempt. The exec package depends on this package only for its public consumer tests; production admission accepts the caller's validator.

Existing `createSandboxPolicy`, `SandboxPolicyService`, `SANDBOX_MODES`, `effectiveSandboxMode`, `renderPolicyContext`, `checkWrite`, `realTarget` and `PathDecision` remain supported during runtime migration. The execution compiler is additive and does not replace existing filesystem checks or session policy resolution.

## Verification

Foundation gates run from the repository root on 2026-10-07:

| Command | Observed result |
| --- | --- |
| `pnpm --filter @i-harness/sandbox-policy test` | 64 tests in 3 files pass, including 41 execution policy tests |
| `pnpm --filter @i-harness/exec test -- test/execution-contract-consumer.test.ts` | 23 public consumer tests pass |
| `pnpm --filter @i-harness/exec --filter @i-harness/sandbox --filter @i-harness/sandbox-policy typecheck` | Exit 0 |
| `pnpm typecheck` | Exit 0; existing workspace dependency cycle warning |

Consumer tests import declared package APIs and compose this compiler and validator with the real admission helper and execution lease. They verify authority changes during asynchronous preparation and at the commit fence, refusal before workload execution, rollback ownership and preserved error causes.

## Limits

Path canonicalization uses lexical platform path normalization and native case semantics. It does not resolve symlinks, junctions, reparse points, filesystem identity or races. Overlapping write and reference roots are rejected in either direction because this foundation cannot enforce nested read-only carveouts. References are descriptive roots for later backend enforcement. The fingerprint is a content digest, not a signature or transferable authorization credential.

No OS confinement or Windows PSEC execution is implemented or qualified by these compiler or fake-boundary tests. Trusted authority acquisition, native final execution fencing, live supervisor/terminal migration and actual confined workload qualification remain later stages of the approved redesign.
