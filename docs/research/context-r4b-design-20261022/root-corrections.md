# Root-selected corrections to the R4B contracts draft

2026-10-22. Docs-only amendment to `contracts-plan-draft.md` following root review. No product, tests, runtime/provider, Git/index work or recursive agents. Prior selected semantics, B1/B2/B3 gates and scope deferrals remain unchanged; this is not self-acceptance or implementation authorization.

## Source observation digest

The previous exporter input accepted `SeedOrigin` with a revision/contentDigest that the exporter was also expected to compute. That invited caller-asserted observations, a second projection to obtain the input, or a circular preimage.

The corrected signature is `exportConversationSeed(view, sourceLabel: SeedSourceLabel, selection)`, where a label is only `{kind:'session',sessionId}` or `{kind:'anonymous'}`. `SeedOrigin` remains output/historical observation data. The exporter returns its computed `sourceObservationDigest` with the final seed/digest; target compilation carries a semantic observation discriminator and bootstrap no longer accepts an independent sourceDigest field.

The draft now defines the exact `SeedSourcePreimageV1`: version, current source label, normalized inherited origin descriptors, selection, turn domain, omissions, artifacts and selected groups. Logical slot0 denotes the current label; reachable inherited descriptors are deduplicated by their complete canonical value, sorted by canonical UTF-8 bytes, and assigned1..n. Every selected nested origin index is rebased through its actual containing manifest, including old slot0, which cannot alias new current slot0. Original source seq/part observations remain unchanged. Unreachable inherited entries are removed; semantic/message order stays fixed.

Omission digest is computed after index normalization from its source/state/calls/relatedInputs, excluding its own digest and dereferencing no origin digest. Source observation hash excludes the final current-origin digest/revision, final origins array/seed digest, compiled header/records, bootstrap identity/clocks, host freshness tokens and native proof. Previously inherited digests are copied historical scalar data, not recursively recomputed. The exporter hashes the one captured selected preimage, fills current output origin with that result, then hashes the completed seed. Validation reconstructs the same preimage without an ancestor archive or second payload projection.

None returns before reading source-label/view fields, projection/payload, normalization or any export hash. The later target compiler may use fixed empty-seed digest constants without observing the parent. A matching selected-content observation hash proves neither owner freshness nor authority; actual host source/target/policy/instruction/Stop guards remain separate and are rechecked across awaits.

B1 examples/tasks now pass labels, use an independent literal preimage hash oracle, cover differently indexed inherited manifests and all nested origin slots, and assert none has zero projection/payload/hash activity. A host guard change must still reject even when selected bytes/hash remain identical.

## Native issue boundary — root selected

The exact new package entry is `@i-harness/llm-seam/internal/native-transfer-issue`, mapping to `./src/prepared/native-transfer-issue.ts`. It exports only `authorizeNativeIssue`; the sole production importer is `packages/core-agent/src/agent/execution.ts`. Authorization is not reexported by the facade, ModelClient or tools. The validator remains package-private in `prepared/native-transfer.ts` and is consumed only by actual payload/execution code.

This follows the existing internal/bedrock-terminal API/source-boundary pattern. It is **not an in-process JavaScript sandbox** and does not cryptographically isolate arbitrary same-process code able to import internal entries. Genuine owned-terminal provenance and private actual payload/plan identity are required; caller-shaped public fields are insufficient.

Authorization binds the final assessed real handle's payload/plan, original generation control, candidateId/active lifetime and retained current/Stop/native constraints. Candidate close invalidates the permit. The candidate retains/authorizes constraints and does not run them separately in its confirmation callback.

Synchronous `PreparedExecutionContext.confirm` performs the permit's active/current/Stop/native checks once **before** `control.confirmExecution`, therefore before candidate receipt and reservation.issue/fetch. Existing ordinary guards remain in their normal path. B3 tasks/tests now require this order, one native invocation, no-calibration mismatch before receipt/issue/network, closed-candidate rejection, real-handle/private-identity checks, wrong derivative/generation/plan and direct-stream/copied-permit negatives. The bounded prepare+assess fallback and cap-derivative contract are unchanged. No account lease or new allowance is introduced.
