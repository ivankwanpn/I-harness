# R4B inherited native replay: focused preflight

2026-10-21. Read-only architectural check after the bootstrap preflight. No implementation, runtime/provider probes, tests, Git/index operations or product changes were performed. This report proposes interfaces and controls; it does not qualify compatibility or execution. Root owns semantic item/history integration. R4C remains separate.

## 1. Recommendation

The candidate is sound **only with three distinct layers**:

1. An optional, strictly validated **archived source observation**, captured from the original confirmed physical receipt and bound to the actual accepted assistant/native payload. It is not account authority and cannot authenticate itself after serialization.
2. A **live source attestation plus target transfer fence**, supplied by the original execution/binding owners. This proves that these exact accepted bytes came through that original live binding and constrains actual target issuance to the same actual binding/credential continuity used by that request. It supplies no allowance, permission or tool authority and is not a revocable management lease.
3. The adapter's **protocol-native preservation check** against the target's actual complete fresh request. Same binding alone does not preserve signed prefix/order/call semantics. A protocol failure cannot be fixed by rewriting the source witness.

Preserve native data for each completed unit when all three succeed. Otherwise explicitly use an available portable representation of that same unit, preserving visible text/calls/results/media and whole-unit closure; if no portable representation exists, block. Never convert thinking/redacted/encrypted payloads into invented visible text. Existing main-session/local/cold replay stays a separate contract: do not tighten the global legacy `canReplayContinuation` helper to implement this new inherited-transfer policy.

The smallest equally sound alternative omits the new archived field and uses only the original execution owner's live accepted-receipt attestation, plus the same target/protocol fences. It preserves qualified same-process native transfers and makes cold/legacy/detached native unverified. The archived field improves explainability and binds source observations through semantic export, but **does not expand the set of trusted cold transfers**. Do not add it expecting a durable account certificate.

## 2. What the existing owners actually establish

| Source | Established behavior / limit |
| --- | --- |
| `packages/llm-seam/src/prepared/execution.ts:7` | `LiveExecutionIdentity` consists of random runtimeId, bindingLifetimeId and authEpoch, scope, and `coldCompatible:false`; its comment explicitly denies principal/lease evidence. `sameExecutionIdentity` at `:24` compares the full tuple. Current shape validation at `:27` is not a strict closed archival codec. |
| `packages/provider-runtime/src/selection/resolve.ts:21`, `:126` | Resolver lifetime owns a random runtimeId; each new resolved API-key binding receives a random bindingLifetimeId and random authEpoch. Managed bearer uses its actual authEpoch. A newly resolved binding with identical labels/credential is still a different binding. Ambient Bedrock receives no such identity. |
| `packages/provider-runtime/src/selection/binding.ts:14`, `:27`, `:35` | Binding snapshots the profile, may rebuild its active client for wait/retry-policy changes, and publishes the same base executionIdentity. That supports binding continuity across these policy-only rebuilds; equality of a raw adapter config supplied by an arbitrary caller is not equivalent provenance. |
| `packages/llm-seam/src/prepared/http-terminal.ts:26`, `:37` | Terminal awaits adapter request/auth preparation, then calls reserve and synchronous confirm immediately before actual fetch. System transport places its callback after proxy/dispatcher awaits (`packages/http-transport/src/system-fetch.ts:219`). Owned-terminal provenance is private in `prepared/owned-terminal.ts:4`; injected fetch overrides cannot enter managed generation. |
| `packages/core-agent/src/agent/execution.ts:38` | Active candidate verifies semantic/payload confirmation against the prepared handle, current request, and base binding lifetime. However authEpoch mismatch is rejected at `:48` only when calibrated or already pinned. This conditional is insufficient for inherited native data: transfer needs an **unconditional** exact-source-to-actual-confirmation check. |
| `packages/core-agent/src/agent/execution.ts:57`; `packages/core-session/src/events/attribution.ts:1` | AcceptedRequestAttributionV1 records auth epoch but omits runtime/binding lifetime; its contract explicitly denies account authority. It cannot be reused as a native account certificate or inherited live receipt. |
| `packages/core-agent/src/agent/model-step.ts:54`; `agent/exchange.ts:13` | Model step retains the actual receipt. Acceptance checks receipt/candidate/send/payload/action/attempt relationships and publishes assistant plus acceptance in one fact group before effects. This is the correct place to derive new source observation, not the provider stream's end event, failed audit assistant, raw importer or semantic compiler. |
| `packages/core-session/src/conversation/render-items.ts:45` | Assistant rendering copies thinking/native data but currently has no source continuity/transfer field. Semantic source refs remain essential for binding a rendered copy back to the actual accepted assistant; matching text is insufficient. Root must carry the new constrained metadata through its shared history/item design. |
| `packages/llm-seam/src/index.ts:87` | canReplayContinuation checks optional model/provider labels and accepts legacy missing labels. It provides protocol routing convenience, not route/account ownership proof. |

Only an actual successful acceptance with a real owned physical terminal can mint a live source attestation. `preparedExecution.confirm` runs before `reservation.issue` (`execution.ts:43–46`), so the mere presence of a pre-issue confirmation object is not yet proof of a successful physical response. Register source attestation only after accepted assistant publication is confirmed and matched to the original step receipt; unresolved acceptance stays unverified until its original receipt is reconciled. Failed/partial audit assistant data, local-test invocations, custom injected streams, copied JSON and structural-v1 acceptance cannot mint this authority. Normal permission/attempt checks remain unchanged (`packages/session-executor/src/lifecycle/generation-action.ts:160` retains its own physical acceptance owner).

## 3. Minimum proposed data and ports

Data-only foundational type in core-session, owned by a new narrow native-transfer contract beside `projection/native-witness.ts` (name proposed):

```ts
interface NativeSourceContinuityV1 {
  version: 1; coldCompatible: false;
  source: { kind: 'session'; sessionId: string }
    | { kind: 'memory'; sourceLifetimeId: string };
  candidateId: string; sendId: string;
  semanticId: string; payloadId: string;
  payloadKind: 'http-json-body' | 'sdk-command-estimate';
  continuity: {
    version: 1; runtimeId: string; bindingLifetimeId: string; authEpoch: string;
    scope: 'binding-credential' | 'managed-subscription'; coldCompatible: false;
  };
  nativeKind: ProviderContinuation['kind'];
  // Binds this assistant's text, calls/args, native blocks/order and native
  // producer witness. Source acceptance/call refs supply whole-unit closure.
  assistantDigest: string;
}
```

This is an optional `assistant/message.nativeSource` field, validated only in the new Session format11 and carried as observation in the semantic seed. Exact own enumerable data fields, ordinary/null prototypes, bounded nonempty scalar IDs, lowercase SHA256 digests, exact enum values, no symbols/accessors/extras, and bounded total metadata size. `nativeKind` must match the actual sidecar. Thinking blocks without an Anthropic continuation may remain legacy/unverified; do not fabricate a continuation merely to fill this field. A session source must name the actual publication owner. An explicitly nondurable source may use the existing execution owner's actual observationLifetimeId as a memory lifetime; this is not a durable session/parent ID and supplies no cold guarantee. Copying either variant never makes anonymous detached content a child of an invented session.

In `agent/execution.ts`, retain a private source-attestation association in the **existing execution owner**, keyed by actual immutable accepted assistant/acceptance objects and their digests. It stores receipt scalars/capability only, no duplicated transcript bodies and no new durable store. A WeakMap can provide weak lifetime retention. Export a host-only port from the real source executor:

```ts
interface NativeSourceSelection {
  source: NativeSourceContinuityV1['source'];
  assistantSeq: number; acceptedSeq: number;
  assistantDigest: string; unitDigest: string;
}
interface AuthenticatedNativeSource { readonly opaqueBrand: unique symbol }
interface NativeSourcePort {
  // Pure lookup against original committed source/receipt association.
  attest(selection: NativeSourceSelection):
    | { kind: 'live'; proof: AuthenticatedNativeSource }
    | { kind: 'unverified'; reason: 'legacy' | 'cold' | 'detached'
        | 'not-accepted' | 'source-changed' | 'unsupported-terminal' };
}
```

The opaque type is illustrative; its constructor/registration stays private. A DTO with these fields is not a proof. The source port checks actual source owner/view, exact accepted object and native/unit content, original physical terminal/receipt and current source lifetime. Pure export may request this lookup without credentials or model work. Forward an existing proof across a legitimate live inheritance hop only for unchanged original native bytes/source refs; a child compiler cannot remint it from copied witness fields. Cold or detached content has no proof even if it reproduces all IDs exactly.

At the actual provider-runtime binding, expose a host-only **binding-owned transfer port**, associated with the resolved binding closure rather than trusting `ModelClient.executionIdentity` supplied by arbitrary callers. It may live on `SessionModelBinding` and be forwarded explicitly by assembly/inherited role binding. The binding is already the route/profile owner; no generic auth registry is needed.

```ts
interface NativeTransferUnit {
  unitId: string; unitDigest: string; assistantDigest: string;
  native: NativeSourceContinuityV1 | undefined;
  proof: AuthenticatedNativeSource | undefined; // never serialized
  portableAvailable: boolean;
}
type NativeTransferDecision =
  | { kind: 'native-candidate'; constraint: NativeTransferConstraint }
  | { kind: 'portable'; reason: NativeTransferReason }
  | { kind: 'blocked'; reason: NativeTransferReason };
interface NativeTransferPort {
  assess(unit: NativeTransferUnit): NativeTransferDecision; // no auth/IO
}
interface NativeTransferConstraint {
  // Opaque target-binding/source proof, keyed to exact immutable unit data.
  assertBeforeIssue(actual: ExecutionConfirmation): void;
}
```

`assess` requires a genuine source proof, the same actual binding/route/model and complete protocol-relevant data. It can produce a tentative native candidate before Codex's final auth resolution; the constraint compares the **actual final** identity including authEpoch. Source sidecar labels, budget metadata or matching route fingerprint alone cannot make the decision native. Route/model changes, unresolved actual identity or unsupported auth modes yield portable/blocked. Different newly resolved bindings remain conservatively incompatible even for the same account; no claim that the random tuple identifies an account.

Place this constraint on the host request/candidate side, separate from wire messages and serialized seed. Extend `createExecutionOwner.candidate(..., transferConstraints)` to invoke every inherited-unit `assertBeforeIssue` at `confirm()` after candidate/payload checks and before returning the receipt, unconditionally independent of calibration. `PreparedStreamControl.confirmExecution` is already a synchronous final owner callback invoked by `preparedExecution.confirm`; a thrown transfer error is classified as execution control and precedes `reservation.issue` and fetch. Current request/fact/Stop guards remain active. A native constraint must not be dropped by withOutputCap, trusted wait/retry/stable wrappers, or alias selection; use existing fixed wrapper provenance rather than accepting arbitrary wrapper registration.

Protocol owners also need a narrow **per-unit transfer preservation result**, not a global upgrade of PreparedValidation:

```ts
type NativeUnitValidation =
  | { kind: 'preserved'; unitId: string; unitDigest: string;
      nativeProjectionDigest: string }
  | { kind: 'portable-required' | 'blocked'; unitId: string;
      reason: 'order' | 'prefix' | 'calls' | 'raw-override'
        | 'native-contract-unavailable' };
```

Each adapter compares the inherited source unit with its final lowered payload and reports whether **that unit's** exact native order/blocks/calls survived. The root's target preparation chooses any portable candidate before measuring/admitting the complete request. A validator cannot silently mutate already measured bytes. Existing `PreparedValidation.native='unverified'` is an aggregate protocol/authenticity observation, not a substitute for per-unit preservation and not a reason to strip all native sidecars: Responses/Chat currently mark native content unverified even when local origin/order preservation can be independently established. Preserve these truthful global validation facts rather than pretending local continuity cryptographically validates provider state.

## 4. Actual transport identity at the final issuance boundary

**The unconditional guard fixes the required gap:** Codex `llm-openai/src/client.ts:60` resolves credentials at execution time and derives actual confirmation authEpoch at `:64`; inherited transfer checking in the existing candidate callback rejects a different/missing epoch before network issuance, including when no usage calibration exists. Current identity handoff at `core-agent/src/agent/response.ts:43` is bounded and requires unsent/unobserved evidence. A new native mismatch must not use that handoff to bless the new credential epoch while retaining old native data.

The current terminal can accurately attest **the captured credential actually sent**, without a token-owner redesign:

1. `client.ts:60–64` obtains accessToken/accountId/authEpoch as one result from the actual trusted Codex token owner. The existing manager checks selected account against the bound account before returning (`coding-plans/src/codex-management.ts:388–393`); `live-execution-epoch.ts:3` derives the process-local epoch from that already-read session/subject/workspace tuple.
2. The same adapter preparation returns the captured identity and request headers containing that exact accessToken/accountId (`client.ts:72–74`). These values are private terminal request state, not looked up again from current settings at fetch time.
3. `http-terminal.ts:33` constructs the actual init from that request; final `execution.reserve`/`issue(request.identity)` occurs at `:37–46`. In the system transport, final issue follows all proxy/dispatcher awaits (`system-fetch.ts:219–224`), and the subsequent fetch uses the same captured init/headers.

Therefore an account/credential change visible at actual token resolution changes or removes the confirmed epoch and is caught by the unconditional inherited constraint. A management change **after** token capture does not itself mean this request switched accounts: fetch still uses the previously captured credential. Compatibility is with that credential, while current source/target/Stop checks continue at their existing final boundary. There is no source-side or target-side reason to infer current account equality merely from labels.

Explicit limit: this is a captured-request continuity observation, **not a revocable management lease** or global logout/revocation linearizability guarantee. `createLiveExecutionEpoch` does not observe later account mutations until called again. B does not need a request-under-account-lock rewrite to establish the actual-credential compatibility contract; such revocation behavior would be separate work requiring its own requirement. Do not add an auth registry, token lease, new ledger or systemFetch final-start redesign for this unit.

For static HTTP routes, captured immutable config supplies the actual credential/identity used at final issue. Runtime binding provenance must establish that this tuple belongs to the real route profile, rather than accepting a user-supplied fake executionIdentity. Dynamic custom credential/transport paths that cannot bind confirmation identity to actual sent credentials remain unsupported for inherited native preservation. Codex cache affinity is keyed to the captured actual account but is not compatibility authority. Auth headers remain outside measured JSON body and no credential values enter archived witness/observations.

**Readmission:** when actual auth makes the native candidate incompatible, abort before issue. If every affected unit has real portable data, allow at most the existing bounded unsent candidate rebuild budget to prepare/measure/admit a portable rendering under the **same logical action and original allowance/deadline**. Store trusted mismatch evidence only in the current candidate state; no tool replay, new input claim, new child spawn, new action allowance or source-witness rewrite. If opaque-only, refuse. Once any transport/output was observed, do not use this unsent readmission route. A final check may not silently switch payloads after measurement. Semantic archive remains an immutable source observation; portable selection is an explicit target request disposition and must not mutate the declared bootstrap seed/digest.

## 5. Route matrix and current protocol constraints

| Route | Qualified native transfer | Portable/blocked cases and required existing checks |
| --- | --- | --- |
| Responses public | Same authenticated live binding + actual full receipt tuple + exact reasoningItems/outputOrder/calls preservation in the target final input. Keep media companions/grouping. | New binding, missing/legacy/cold proof, changed endpoint/model/credential continuity, invalid order → explicit portable if text/calls/results exist; opaque-only → block. `llm-openai/src/request/messages.ts:61` currently uses labels and `:74` silently drops reasoning on stale outputOrder; inherited transfer must turn that disposition explicit. `request/validate.ts:107` checks reasoning item grammar but marks authenticity unverified; previous_response_id/conversation/item references and hosted opaque alternatives are not a portable source or proof of ownership. |
| Responses subscription / Codex | Same actual subscription binding plus unconditional final check of the captured actual credential epoch, exact native output order/call grouping. Subscription namespace/body rules remain. | Public↔subscription is a route change even with matching model/provider labels. Unknown authEpoch, different credential epoch returned by actual auth resolution, or missing live proof → portable/block. Official endpoint and no-configured-header checks are already enforced at `llm-openai/src/client.ts:14`. Namespace `ih`, include encrypted content and store=false remain protocol owner behavior (`request/body.ts:58`, `:64`), not inherited execution rights. |
| Chat / openai-compatible | Same authenticated live binding and exact original reasoning_content associated with the same assistant/calls. Add the per-unit final preservation check; do not infer remote provider support from labels. | `llm-openai-compatible/src/request/messages.ts:23` currently uses labels. `request/validate.ts:136` only checks reasoning_content type and marks native unverified. Unknown/custom route semantics stay explicit; real visible content/calls can downgrade, reasoning-only cannot be promoted to an invented assistant summary. |
| Anthropic Messages | Same authenticated binding **and** original prefixFingerprint, exact toolBindings/args, retained thinking blocks/contentOrder and applicable producer thinking/effort/beta facts against the target's actual fresh request. | Prefix includes system/tools/prior wire messages (`llm-anthropic/src/request/messages.ts:39`). A child role/system/tool change can invalidate native even on the same binding. Never rebase source fingerprint to child prompt. Mapper/validator already distinguish portable removal and opaque-only failure (`request/validate-native.ts:34`), and completed earlier turns may change thinking mode while ongoing turns remain constrained (`:52`). Preserve those rules. |
| Gemini | Same authenticated binding, exact signed parts/positions/order and original callBindings/name/args/signature alignment in the final body. Preserve unsigned visible parts and media positions. | `llm-gemini/src/request/messages.ts:33` verifies replay/order and `:51` binds call args; `request/validate-native.ts:8` checks exact signature/part positions and handles each assistant separately. Raw body overrides or moved/dropped signatures cannot borrow another unit's preserved status. Downgrade only from real visible text/calls; signature/thought-only → block. |
| Bedrock Converse | Conceptually requires the same actual SDK credential continuity plus exact signed message prefix/calls/order/input-surface checks. **Current shipping ambient path does not provide that credential witness**, so no safe inherited native-preserved result can be claimed there merely from sharing a client. | `provider-runtime/selection/resolve.ts:126` withholds identity for ambient auth. `llm-bedrock/src/sdk-terminal.ts:27` confirms captured config identity at the real final SDK handler, after signing; it does not expose which ambient credential tuple signed the request. Current native validator (`request/validate-native.ts:52`) requires matching calls and signed messagesPrefixId and reports changed inputSurfaceId as unverified. Current B may portable/block unknown credential transfer, preserving native bytes as source observation. Enabling a positive inherited Bedrock native control requires an actual credential-bound terminal witness from the existing SDK credential owner; inventing identity from region/profile/client object is unsound. Injected send-only runtime remains standalone-only. |

Portable media is not opaque reasoning. Do not remove image-bearing user/tool companions just because their assistant's native state downgraded; keep the source unit/media ordering and normal target modality validation. A target unable to accept required media must report that limitation through the actual preparation/admission result. Signed native prefix checks may still force downgrade when history selection changes prior messages.

## 6. Files and real-entry oracles for the executable plan

Narrow ownership changes belong in core-session native-source event codec/validation; core-agent `agent/execution.ts`, `agent/exchange.ts` and their source port plumbing; provider-runtime `selection/binding.ts`/binding DTO; the existing prepared execution control plumbing; and each adapter's existing request mapper/validator. The actual HTTP terminal/Codex token/systemFetch owners can retain their credential-snapshot contract, with targeted controls verifying the identity/headers association described above. Root's semantic compiler forwards source observations and target transfer constraints through the one shared projector rather than teaching adapters how to traverse archives. No new generic account registry, attempt ledger, store or scheduler.

Proposed independent controls, not run:

1. Drive actual spawn/all first preparation using a completed parent native+media unit from a real original owned physical receipt fixture. Share the actual same live binding (not a second resolve with identical labels), unchanged protocol-required prefix, and same final auth epoch. Inspect exact first prepared payload/order, fresh role/system/tools, source observation and one guarded transport. Include positive Responses, Chat, Anthropic and Gemini controls whose protocol preconditions truly hold; a Bedrock positive requires the missing real credential witness, not an identity supplied to a fake runtime.
2. Same labels with different binding lifetime, endpoint/route, public↔subscription, new runtime, account/auth epoch, and copied witness JSON must not preserve native. A cold reopened source and an anonymous detached source with matching receipt fields remain unverified. Assert explicit portable disposition preserves exact visible text/calls/results/media; opaque-only source blocks before model/count generation/tool dispatch.
3. Vary only source assistant text, tool args/name/id, call order, native block/order/signature, media grouping or source refs while retaining the witness/proof. Assert source digest/protocol mismatch; no global “some native survived” status can cover another unit. Include multiple units from different historical auth epochs in one seed and require per-unit decisions.
4. Codex auth resolver returns a different/missing epoch after prepare, with **no usage calibration**. Confirm zero network start and zero reservation.issue on rejected native candidate. Same epoch can proceed. Interleave management-state change during proxy/dispatcher or generation-reserve waits **after** token capture: independently inspect the captured actual credential/account headers and confirmation epoch, proving compatibility decision concerns the request really sent and does not silently claim a current-management lease. Current source/target/Stop fences must still reject their own stale/cancelled cases. Assert no credential/headers/body values enter observations.
5. For portable readmission, count original admitted child input and logical action once, no accepted-tool replay, no new spawn, bounded candidate rebuild and unchanged allowance/deadline. Verify actual fallback payload is newly measured/validated rather than changed after confirm. Opaque-only mismatch or any already-issued/observed attempt refuses this readmission.
6. Malformed native-source metadata: extra/inherited/accessor/symbol fields, bad prototype, overlong strings, invalid digest/nativeKind, unsupported version/format and copied permission/action fields. Reject at actual append/stage/cold import boundaries, without treating a strict codec as proof of provenance. Accepted format10 predecessor refuses format11 including header-only bootstrap before repair/auth/execution.
7. Assert original main/local/cold native replay controls retain their existing behavior. Pure semantic export/fork inspection/source attestation must record zero credential resolution, provider work or models. Tests must inspect real request bytes/transport counters independently of the compiler's own expected output.

## 7. Decisions and limits to freeze

- Adopt archived witness + private original-source live attestation, or choose the simpler live-attestation-only variant. Both must refuse unverifiable cold native transfer while preserving real portable data; archived fields cannot relax this.
- The unconditional inherited transfer check is necessary even without calibration. Existing identity handoff alone can acknowledge a new auth epoch and therefore cannot certify old native state.
- Actual captured-credential compatibility is the B contract; global active-account revocation after token capture is separate. Current terminal identity/headers association plus unconditional inherited checking can meet the former. A random epoch returned earlier remains an observation, not a lease.
- Bedrock ambient credential continuity is not available at the current port. Conservative portable/opaque refusal is truthful; a positive native-preserved claim requires additional concrete SDK credential-owner evidence, not a new generic auth subsystem.
- Native compatibility remains conditional on actual fresh target surface. The framework's requirement to preserve compatible completed native units does not permit rebasing signatures/prefixes or copying parent system/tools into child authority to force a match.

No product implementation or verification claim follows from this preflight.
