# ContextEngine R3 F3a — Pure Prepared Assessment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One implementer, followed by one fresh GPT6.1Sol task reviewer. No recursive agents. Steps use checkbox (`- [ ]`) syntax.

**Status:** COMPLETE — independently approved at `c87b0e599e3ba00a7b90e92a8323840694def52a` from BASE `6178b8ec908d5e897031874f8c891018dd018757`. [Verification](../../research/2026-10-17-context-engine-r3-f3a-verification.md) records exact source/receipt scope, the resolved test-provenance question and retained qualification warnings. The required agent scope includes18 individually reproduced BASE failures with named later integration obligations; this is not a full-program pass or whole-F3 completion. Root's consumer-graph amendment below was included in the approved review.

**Goal:** Make the current main request construction and prepared budget calculation reusable without mutating the live context observation, execution identity or calibration state during a private candidate probe.

**Architecture:** Extract the existing calculation into ContextEngine and the existing request construction into a data-only core-agent helper, then route the actual main caller through them. Keep calibration acceptance, recovery authorization, budget publication and request telemetry in their existing live owners. This is an independently reviewable F3 prerequisite; the subsequent connected F3 reduction task consumes these functions and replaces the old compaction owner.

**Tech Stack:** TypeScript, existing pnpm/Vitest workspace; no new third-party dependency. The one new workspace dependency `context-engine -> token-meter` is already prescribed by the approved framework.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-{redesign,framework,r1-contracts}.md`; `docs/research/2026-10-16-context-engine-r3-f3-preflight.md`. The latter's final target, positional transaction, output-eligibility and summary requirements remain required by connected F3; this task does not certify those later capabilities.

## Global Constraints

- One product writer and fresh GPT6.1Sol/high review; no recursive agents. Product `0.1.13-rc.1` and original decomposition `27/43` remain unchanged.
- Preserve all six route kinds, raw-option precedence, native/signature/image order and actual execution ownership. No provider request, account/profile access or installed-data mutation during qualification.
- ContextEngine does not import core-agent, session-executor, subagent, Desktop, concrete llm adapters or compaction. It may consume core-session, token-meter and llm-seam contracts/primitives. Do not add a second budget, calibration, request or raw-history owner.
- No replacement publication, new policy defaults, F4 physical-attempt mechanism, E capacity-domain policy, R4 retention/seed/delivery or R5 observation overhaul in this task.
- Preserve current main admission semantics, including the unresolved recovery restriction, current unsupported/unknown cap behavior and unknown-window unavailability. Capacity fit is not send authorization.
- Retire the old internal `checkBudget(Session,...)` entry when its last production caller moves to the scalar primitive. This is an explicit package-API removal, not a claim that the old fallback is still supported; retain actual runtime semantics and other activeTokens consumers.
- New cohesive leaves normally 150–400 lines, functions at most 120; facade 150–250. Extract the touched responsibility, not an unrelated file-size campaign. Tests/scripts are exempt from decomposition targets.
- Keep RED receipts, failed manifests, known baselines and source/artifact identities. No audit reseed, exemption, synthetic consumer, timeout weakening or erasure of F1-CLOSE-OBS-01/B2/R6 obligations.

## File and responsibility map

| Path under packages/ | Responsibility |
|---|---|
| `token-meter/src/budget.ts`, `src/index.ts` | One scalar `compareBudgetTotal` primitive consumed by actual prepared assessment; retire the now-unused legacy `checkBudget` wrapper/export instead of a fake Session or synthetic consumer. |
| `context-engine/src/contracts/assessment.ts` | Data-only exact input/result types for the current named legacy calculation. |
| `context-engine/src/admission/assess.ts` | Pure A-to-optional-B selection, final B validation/pricing, capacity-only comparison and existing snapshot construction. |
| `context-engine/src/index.ts`, `package.json`, workspace lock importer | Export only the function/types used by core-agent; declare the existing framework's direct token-meter edge. |
| `core-agent/src/agent/budget.ts` | Existing live calibration/observation/publication owner; delegates calculation and then installs the result. |
| `core-agent/src/agent/execution.ts`, `context.ts` | Read-only expected execution observation for budget calculations; execution candidate/confirmation retains mutation authority. |
| `core-agent/src/agent/request-input.ts`, `step-input.ts` | Pure construction from captured snapshot; actual step caller retains prefix telemetry, hooks and input claim scheduling. |
| Tests listed below | Literal independent arithmetic, mutation boundaries, exact native/request behavior and real main integration. |

### Task 1: Extract and consume the pure preparation/assessment boundary

**Consumes:** reviewed F2 immutable committed SessionView and ContextSnapshot; B2 `createAcceptedCalibration.probe`; existing llm-seam PreparedModelRequest/validation/withOutputCap; current main admission and execution owner.

**Produces these exact interfaces:**

```ts
// token-meter/src/budget.ts
export function compareBudgetTotal(
  tokens: number, contextWindow: number, reserveRatio = 0.9,
): BudgetResult;

// context-engine/src/contracts/assessment.ts
import type {
  CalibrationRetirementReason, ContextBindingMetadata, RequestBudgetSnapshot,
} from '@i-harness/core-session';
import type { ProjectedInputFacts } from '@i-harness/token-meter';
import type { PreparedModelRequest } from '@i-harness/llm-seam';

export interface ProjectionEstimate {
  readonly tokens: number;
  readonly calibrated: boolean;
  readonly disposition?: CalibrationRetirementReason;
}
export interface LegacyPreparedAssessmentInput {
  readonly ownerSessionId: string;
  readonly binding?: Readonly<ContextBindingMetadata>;
  readonly bindingRevision: number;
  readonly projectionRevision: number;
  readonly neutralFingerprint: string;
  readonly requestContext: NonNullable<RequestBudgetSnapshot['requestContext']>;
  readonly contextWindow?: number;
  readonly configuredCap?: number;
  readonly reserveRatio?: number;
  readonly recoveryAuthorized?: boolean;
  readonly selectOutputCap?: boolean;
}
export interface PreparedAssessmentReaders {
  // Synchronous, read-only observations over this captured assessment.
  readonly estimate: (input: ProjectedInputFacts) => ProjectionEstimate;
  readonly recoveryRequired: (input: ProjectedInputFacts) => boolean;
}
export interface LegacyPreparedAssessment {
  readonly prepared: PreparedModelRequest;
  readonly snapshot: Readonly<RequestBudgetSnapshot>;
  readonly capacityFit: 'yes' | 'no' | 'unavailable';
  readonly calibrated: boolean;
  readonly disposition?: CalibrationRetirementReason;
}

// context-engine/src/admission/assess.ts
export function assessLegacyPreparedRequest(
  prepared: PreparedModelRequest,
  input: LegacyPreparedAssessmentInput,
  readers: PreparedAssessmentReaders,
): LegacyPreparedAssessment;

// core-agent/src/agent/request-input.ts
export function buildContextRequest(
  input: Pick<ContextSnapshot, 'conversation' | 'surface'>,
  options: {
    sessionId?: string;
    signal?: AbortSignal;
    requestScope?: LLMRequest['requestScope'];
  },
): LLMRequest;
```

No public `OwnedBudget.probe` or injectable private-candidate service is added before its actual F3 reduction consumer exists. The exported assessment function already has the live main consumer in this task. `capacityFit` supplies the same calculation's authorization-independent result; it does not alter the existing authorization-sensitive `snapshot.admission`.

- [x] **Step 1: Record actual BASE and freeze the extraction boundary.**

Read this task, Global Constraints and F3 preflight. Record `git rev-parse HEAD`, source hashes and exact commands in the task report. Verify the actual current `budget.ts:assess`, `execution.expected`, `step-input.ts:prepareRequest`, token-meter `checkBudget` and ContextEngine index. Root binds the accepted F2 revision; do not use `HEAD~1` or a historical F1 whole-suite pass as this task's evidence. Preserve F2's source/receipt work and root docs.

- [x] **Step 2: Write literal RED for pure arithmetic and final derivative use.**

Create `context-engine/test/prepared-assessment.test.ts` with controlled prepared capabilities; no live transport. Each fixture's stream throws if called. Handwrite expected values rather than calling the production comparator for the oracle.

```ts
expect(compareBudgetTotal(9000, 10000, .9)).toEqual({
  state: 'ok', tokens: 9000, budget: 9000,
});
expect(compareBudgetTotal(9001, 10000, .9)).toEqual({
  state: 'overflow', tokens: 9001, budget: 9000,
});
```

For a supported route with window10000, reserveRatio.9, measured input7399, final output600, assert safetyMargin1000, capacityFit yes, admission fit and remainingInputBudget1001. With the same final candidate and unresolved recovery, capacity remains yes but admission is compact; explicitly authorized recovery yields fit without consuming any authorization in the calculator. Unknown window and incomplete input give unavailable, never a fabricated fit.

Construct A whose derivative B changes the input measurement and identity; assert exactly one derivative creation, B validation, B input/output facts and B advisory disposition. A's provisional anchor miss must not retire a live anchor when B is compatible. A valid but B-invalid request fails before stream and observation installation. Test supported/unsupported/unknown cap distinctions, route output minimum, explicit `selectOutputCap:false`, final binding mismatch and unchanged raw final candidate identity.

Run `pnpm exec vitest run test/prepared-assessment.test.ts --maxWorkers=2 --minWorkers=1` in `packages/context-engine`; retain the expected missing-interface RED, not an unrelated invalid fixture error.

- [x] **Step 3: Extract the scalar comparison and existing calculation once.**

`compareBudgetTotal` performs the existing validation and exact `tokens > floor(contextWindow*reserveRatio)` comparison. The prepared assessor never takes or creates a Session and never invokes activeTokens.

Root consumer-graph ruling2026-10-17: the initial extraction exposed a contradiction in the plan's proposal to retain the old wrapper. Main was `checkBudget`'s only production consumer; after the move it has none, and this private workspace package has no other source/apps/e2e/scripts caller. Retire the wrapper body and barrel export rather than hiding dead code behind an internal import or inventing a consumer/audit exemption. Keep activeTokens and its real callers untouched. Migrate the original valid scalar under/over/ratio/numeric-total tests to literal `compareBudgetTotal` controls; prove full prepared input is charged once in the actual assessor/owned-caller tests. Retire only the removed wrapper's Session-fallback/overhead-parameter-specific tests, recording their disposition explicitly; do not recreate the wrapper in test code. This intentionally removes the old internal package entry; main runtime policy/output behavior remains unchanged. Also remove any unconsumed `ProjectionEstimate` barrel exposure while retaining the real contract-module type.

Preserve these existing selection rules verbatim in meaning:

```ts
const margin = window === undefined ? 0 : Math.ceil(window * (1 - ratio));
const availableA = window === undefined ? undefined
  : Math.max(0, window - margin - estimateA.tokens);
// Supported caps, and the existing unknown+neutral-only compatibility case,
// may choose one derivative. Unsupported caps retain their actual reserve.
const final = mayDerive && ceilingA !== undefined
  && availableA !== undefined && availableA >= outputA.minimumCap
  ? prepared.withOutputCap(Math.min(ceilingA, availableA)) : prepared;
// Revalidate/reprice final; never use estimateA as final's measurement.
```

Validate A and B through existing llm-seam guards and binding comparison. Calculate final output reserve, role/fixed/reasoning breakdown, estimateSource/confidence and historical identity exactly as the current live code. This named legacy capacity comparison requires coverage other than `incomplete`, a known window, the scalar budget and supported minimum output. Preserve the existing `neutral-only` custom compatibility behavior and its explicit coverage label; this is not a claim of complete physical provider measurement. Test that case explicitly. Only `snapshot.admission` also applies unresolved recovery versus the explicit authorized flag. Read recovery against the final measurement, not A. Freeze data facts; keep the original prepared handle, not a JSON copy.

The calculator performs no awaits, prepare/auth/send, telemetry, append, calibration record/retire, latest/captured/invalidated mutation or execution confirmation. Its two narrow readers must be existing pure observations captured synchronously by the live caller; no permission minting or recovery.admit callback. Add the direct token-meter workspace edge and update only that lockfile importer.

- [x] **Step 4: Wire the real live owner and prove observation purity.**

`createOwnedBudget.assess` builds the scalar input and read-only readers, calls `assessLegacyPreparedRequest`, then installs latest/captured/invalidated exactly once after success. Its existing `record`, `retire`, `checkpoint` and accepted-v2 lineage remain the only mutation/publication owners. A failed assessment preserves the previous observation and anchor. Main admission still retires an advisory disposition only after its current-candidate check.

Add `peekExpected(base): EpochObservation` to the existing execution owner, using the same lifetime/value selection as expected but no mutation. `expected` and execution candidate confirmation retain their existing state ownership. Context's budget dependency uses `peekExpected`; do not create a new execution owner or observationLifetimeId for probes. Literal test: learn observed auth epoch F for base lifetimeL, peek another lifetimeM, then peek L; F remains. The current mutating execution transition still enforces E→F→G termination and stale confirmation refusal.

Extend `core-agent/test/owned-budget.test.ts` and `execution-calibration.test.ts` with the actual owner controls. A hypothetical mismatch followed by compatible assessment produces no extra usage-retire/budget facts or lost execution observation. A real committed rewrite still retires through the existing B2 path once. Use real owned/calibration fixtures where the behavior requires accepted lineage, not arbitrary fabricated request attributes.

- [x] **Step 5: Separate captured request construction from live telemetry.**

Move only `renderConversation`, `assertMessagesFromLog`, copied tool schema, captured system/effort/output cap, requestScope/retryOutput/sessionId/promptCache and signal assembly into `buildContextRequest`. It accepts only the captured conversation/surface pair plus the small options object above, never Session/AgentDeps or publication coordinates. The live caller passes its actual snapshot. This keeps the later private candidate caller from fabricating a committed ContextSnapshot merely to build a request. Preserve existing cache key `ih_` plus first48 SHA256 hex characters of sessionId, `retryOutput:'discard'`, absence behavior and exact message/native order.

`createStepInput` calls the helper and retains its current prefix/rewrite telemetry and mutable previous fingerprints. Hooks, inbox claim and step/start remain in their original real-step paths. No pure builder call increments counters, emits provider/call, mutates the snapshot, claims input or creates action/attempt identity.

Create `core-agent/test/request-input.test.ts`: exact literal text/image/tool/native arrays and system/schema/effort/output fields, repeated build equality, immutable snapshot unchanged, no sessionId means no cache key, signal identity preserved. Compare the actual main caller's prepared body and observer counts in existing `context-snapshot`, `final-validation-routes` and `owned-budget` tests. The pure helper does not assert invented adapter compatibility; actual adapter validation continues to own it.

- [x] **Step 6: Finish structural extraction and qualification.**

Run the new tests and affected covering tests sequentially, with `--maxWorkers=2 --minWorkers=1`:

- token-meter: `test/budget.test.ts test/accepted-calibration.test.ts`.
- context-engine: full package (snapshot and new pure calculation).
- core-agent: `test/request-input.test.ts test/owned-budget.test.ts test/execution-calibration.test.ts test/context-usage.test.ts test/context-snapshot.test.ts test/context-update.test.ts test/context-recovery.test.ts test/final-validation-routes.test.ts test/context-effect-freshness.test.ts test/deep-context-request.test.ts test/projection-rewrite.test.ts test/compaction-binding.test.ts`.

If an original test must change for new internal ownership, preserve its observable assertions; this task changes no provider or summary policy. Existing B2 reasoning failure remains separately evidenced and is not a blanket test exemption. No full unrelated package rerun without changed code, failure or unresolved concern.

Run `pnpm --filter @i-harness/token-meter typecheck`, then the same command for `@i-harness/context-engine`, `@i-harness/core-agent`, `@i-harness/compaction`, `@i-harness/session-executor`, `@i-harness/sdk` and `@i-harness/desktop-gateway`, sequentially. Each verified package script runs `tsc --noEmit`. Run root `pnpm exec tsc --noEmit -p e2e/tsconfig.json` and `pnpm verify:reachability` without reseeding. Record actual command/exit/stdout hashes. Freeze source before final runs; if it changes, refresh only affected evidence and state the revision distinction.

Make fresh Gateway and CLI copies using the existing build commands and distinct `.tmp/context-r3-f3a-*` output paths, verify the CLI dist, and smoke the actual copied main path with controlled transport: one accepted ordinary step, exact final cap measurement, then a controlled cap-changing derivative; no extra preparation from repeated context observations. Hash copied source against the qualified final source. No installer/profile or live-provider work.

- [x] **Step 7: Commit and hand off to the fresh review.**

Use coherent extraction and behavior commits, explicitly stage only task files. Keep root documentation/other writer files unstaged. The report records BASE/HEAD, exact active consumer map, tests/receipts, source identity, copied-runtime proof and any limitation. Return DONE or DONE_WITH_CONCERNS with commits and report path. Root reviews the entire task range; do not push, merge, publish, spawn reviewers or mark all F3 complete.

## Self-review and next connected boundary

This task supplies actual pure construction/calculation, not a dormant orchestrator. All existing main caller output and recovery restrictions are preserved; only a read-only expected-execution lookup prevents hypothetical lifetime reads from clearing valid observation. Independent review can reject this extraction without involving the larger replacement publisher.

After acceptance, connected F3 consumes the exact exported calculator/builder through a bounded private preparation port; adds final-body text eligibility and structural checkpoint acceptance; owns typed source selection/finite summary/private preview/fenced publication; retires all old automatic/manual/recovery success paths. Its exact plan must bind accepted F2/F3a APIs before dispatch. The approved target is still `capacityFit && I+R+H < thresholdRatio*W`, distinct from recovery transport authorization. F4 then owns physical attempt limits, and E replaces the named legacy budget policy. No phase-completion credit is implied here.
