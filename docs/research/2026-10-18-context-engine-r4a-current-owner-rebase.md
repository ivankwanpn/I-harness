# R4A current-owner rebase and bounded artifact decisions

Planning record, 2026-10-18. Read-only source inspection at accepted commit `221051b2630de429038fe04900122e757f55711d`; the active R2E writer owns subsequent product changes. This document is not an executable dispatch or implementation acceptance. It supplements the [retention preflight](2026-10-16-context-engine-r4-retention-preflight.md), [approved redesign](../superpowers/specs/2026-10-15-context-engine-redesign.md), and [framework](../superpowers/specs/2026-10-15-context-engine-framework.md). R2E must be accepted and its actual format/reader interfaces rebased before R4A dispatch. No reference-project research, product edits, live requests or test runs were performed for this note.

Rebased after E acceptance at9fb933f6: the [R4A executable plan](../superpowers/plans/2026-10-18-context-engine-r4a-retained-results.md) fixes format9→10, exact DTO/runtime ports,64byte Merkle-index header, bounded canonical JSON-line exec-frame codec, source completeness, synthetic pre-dispatch finalization and actual unknown-outcome readers. Its initial self-review is recorded in the R4A SDD ledger. This note's earlier next-gate wording is historical planning context; no R4 product completion is claimed.

## Existing ownership now available

The prior preflight predates F1–F4. Preserve the following real owners instead of designing a second effect/capture system:

| Existing path under packages/ | Current responsibility and consequence for R4A |
| --- | --- |
| core-tools/src/registry/retained-outcome.ts | Real dispatch registers outcome/reference sources on its trusted ToolExec. Recovery retains original output and captured reference handles. Reconcile those handles; do not run the body again after artifact or fact failure. |
| core-agent/src/tool-batch/record.ts | Stores the finalization promise and captured result fact, then admits/reconciles the same fact. Keep once-only finalize/post-tool behavior and ordered slot commit. |
| core-session/src/managed/capture.ts | New strict DTOs and legacy one-time lowering are distinct. Current legacy capture still makes a complete encoded string and parsed copy. R4A must not claim streaming merely by feeding this complete string to a sink afterward. |
| core-session/src/serialization/json-data.ts | Stack-based source-order JSON semantics exist, with a native fallback for non-data legacy values. The current encoder accumulates output and joins it. Reuse its semantics in a streaming/once-lowered path; do not duplicate divergent codecs. |
| session-executor/src/lifecycle/reference-retention.ts | Keeps actor/parent grant and capture stages, with passive settlement of the original captured fact. Preserve this ordering and conservative unknown handling while composing durable artifact receipts. |
| session-executor/src/context-output.ts | Optional Context Mode still clips/captures output after the body and may return the original when disabled, source changes, capture refuses or cancellation is observed. This is not the mandatory bounded result owner. |
| exec/src/capture/output.ts and retention.ts | Own actual ordered stdout/stderr frames and capture settlement. This is the point for the full-result tee before collector truncation. Do not rely on the later spill reader to recover discarded bytes. |
| mcp-client/src/bridge.ts | Still drops structuredContent on success and stringifies content into a thrown error on isError. Normalize before these branches lose the original result. |
| output-retention/src/spill-guard.ts | Its ordinary no-fit fallback remains the full original result. It also wraps Code Mode program values. Both production behaviors must retire when the new owner is enabled. |
| subagent/src/report-policy.ts | Final report limits exist, but digest/page preparation still serializes full rows and allocates full body Buffers. New retained bodies must be referenced by committed revisions without repeating full strings in task/job/outbox metadata. |

`tool-batch/record.ts` currently infers isError from payload fields named error/code. New managed result outcomes must instead come from trusted producer settlement; arbitrary result-shaped payloads are data. Legacy readers retain their historical interpretation rather than rewriting old facts. Define the exact trusted outcome handoff in the executable R4A plan before changing that producer.

## Finalization and program-value boundary

An additional read of unchanged owners while R2E is under review establishes the integration point precisely. `core-tools/src/index.ts` currently accepts only PluginContext; `registry/finalize.ts` runs the existing tools/post-execute event and returns the same output. Both `core-agent/src/tool-batch/record.ts` and `code-mode/src/broker.ts` cache that finalization promise. Code Mode also caches the complete finalize→record→post-tool promise, while `broker/records.ts` can reconcile an already captured result separately. The registry's dispatch recovery registration is removed on ordinary dispatch success, before finalization begins.

Consequently a new fallible artifact operation cannot simply be inserted into finalize and retried by invoking finalize again. It needs an original-result finalization handle bound through the existing prepared-call/source owner. That handle must retain the completed hook phase, once-lowered value, original artifact operation and later original fact capture separately. Reconciliation may resume only those unfinished storage phases; it must not rerun body/getter/toJSON/hooks or revive an already rejected/retired guest invocation. A permanently rejected cached promise is not itself a recoverable result state.

The executable plan must define the narrow registry/composition port and private retained-finalization lookup used by BOTH normal tool batches and Code Mode. Preserve existing post-execute ordering; capture the stable effective result after that phase. If hook/encoding completion fails, retain the truthful execution outcome with an explicit incomplete/unavailable or recovery-required disposition, without claiming an original complete representation that was never captured. Program consumers receive the once-lowered structured value under existing transfer limits, while archive/model readers receive the bounded envelope. A preview object must not replace the guest value through the outer spill cascade.

The actual exec reader is still a bounded late reader of stdout/stderr temporary spills. It verifies temporary-file identity but concatenates labelled text and cannot recover bytes discarded by OutputCollector. Therefore mandatory full capture must enter `exec/src/capture/output.ts` at the ordered frame consumer before collection loss, through a narrow injected sink. Later shell/job getters may use its immutable ref; a model-supplied spillPath or ref-shaped object must never acquire that sink's authority. Exact codec/frame/page contracts remain part of the executable R4A gate, not an assumption that a text-only ContextCapture interface already provides them.

## Fixed compatibility boundaries

- Extend the existing workspace Context Output artifact responsibility. Mandatory result retention is independent of optional Context Mode/index enablement. Keep the existing configurable 512MiB total quota; no second raw-result store or hidden quota increase.
- Keep ordinary model text/envelope at 64,000 UTF-8 serialized bytes, child preview at 2,048 UTF-8 bytes and aggregate reports at 16,384 final JSON bytes. Escaping and metadata count. Typed media has its existing separate limits; these are not total request/media caps.
- Retention state is separate from execution outcome. Known storage/quota refusal can publish a bounded truthful unavailable disposition through the original source. Unknown artifact/fact outcome retains its exact pending identity and source; it cannot release data or reset execution authority.
- Program value and model projection are separate. A nested Code Mode tool keeps its once-lowered structured value under existing guest transfer limits; model preview must not replace that value. A transfer rejection does not undo the already executed tool or its admitted host artifact.
- Supported images retain order and the current ImageInput contract. Do not silently invent audio/resource wire support or turn binary content into preview text. Reference-only remote resources remain references; no implicit fetch.
- Code Mode worker output already dropped before host admission remains explicitly source-limited. Full arbitrary guest streaming and higher guest limits are not claimed by a normal/exec 100MiB retention test.
- Existing raw session/legacy artifacts remain readable under their truthful original guarantees. New result facts require a non-ignorable versioned envelope and the next actual format fence after R2E; detached ignorable context/result-ref metadata is insufficient.

## R4A-INT-01: rooted range integrity

Choose a fixed-chunk Merkle index for new immutable artifacts so a bounded page does not hash the full body or read an unbounded digest list. This qualifies the new format only; legacy refs require explicit streamed verified import into a new immutable revision before using this claim.

1. Content chunks are at most 65,536 encoded bytes. Stream the whole-content SHA-256 while capturing. Preserve exact codec identity and encoded byte count; original stdout/stderr frame bytes and encoded structured JSON are different scopes.
2. Let n=max(1,ceil(encodedBytes/65536)), p=the least power of two >=n. Store a complete binary digest tree in a fixed binary index, in heap order with 32-byte SHA-256 nodes. An empty body has one actual empty leaf. Padding leaves are distinct from actual empty chunks.
3. Canonical hash inputs use binary domain separation: actual leaf = SHA256(0x00 || u64be(chunkIndex) || u64be(chunkLength) || chunkBytes), branch = SHA256(0x01 || leftDigest || rightDigest), padding = SHA256(0x02 || u64be(chunkIndex)). Validate all counts/offsets and index-length arithmetic before I/O.
4. A bounded closed manifest binds format/codec, encodedBytes, contentDigest, chunkBytes=65536, n, p and treeRoot. The result's committed immutable ref binds the manifest digest; mutable ACL/pin metadata cannot alter content identity.
5. Build the index with bounded chunk/level buffers and on-disk levels or fixed-offset writes; never retain all content chunks in memory. The exact index size is headerBytes + 32*(2*p-1). Both staged and final physical bytes, authoritative metadata and bounded index work must be charged to the existing quota. Do not reserve only the body length.
6. A page verifies only touched content chunks plus their sibling paths against the committed treeRoot. At most one chunk buffer plus bounded output/proof buffers is needed at a time. Work scales with requested range and tree depth, not total content bytes. Index tamper, swapped leaf, truncated index, corrupt header, wrong codec/count and wrong manifest root are explicit refusals.
7. Public text pages use exact UTF-8 byte offsets and include the final serialized envelope in the response budget. A mid-codepoint start is refused; an end is backed down to the previous complete codepoint. If metadata plus the next character cannot fit, return a bounded explicit refusal, not an empty nonadvancing page. Framed/binary artifacts use their declared reader codec rather than pretending arbitrary bytes are UTF-8.

The executable plan must fix the short binary header and manifest field limits, exact safe arithmetic, framing codec, and independent leaf/root vectors. This record selects the integrity design; it does not claim a partially specified index is ready to implement.

## R4A-OWN-01: commit and pins

The artifact store and F1 session document remain distinct owners. Use the existing fs-lock primitive for qualified workspace mutation ownership; do not hold a session allocation lane while streaming an artifact. Unsupported lock platforms retain explicit unsupported behavior rather than a weak PID-file fallback.

Artifact bytes/index/manifest and a pending source/document pin commit first, with checked full writes and sync. Only then may the original F1 source capture/publish an envelope containing that exact ref. The pin remains conservative until the session receipt/reconciliation proves the reference's disposition. A crash between stores is not an atomic distributed transaction: committed artifact plus unknown session publication stays protected and is reconciled by original identity.

Use document-lifetime pins for newly committed results and grants. Archive is not deletion. TTL, quota GC and generic clear cannot remove pinned or publication-unknown artifacts. Confirmed document deletion releases only its own pins; other owners/grantees remain. Source revocation can deny reading without releasing storage ownership. Proven unreferenced orphan cleanup is separate from uncertainty; uncertainty keeps the pin.

The current ContextStore startup hashes every entire blob and rebuilds its search database from all bytes. The new managed artifact path must open authoritative metadata without that full-body/index dependency. Search is optional/rebuildable, bounded by its existing text/work policies and explicitly partial; it must not veto a committed ref because the optional index is absent. Actual page integrity is checked by the rooted range scheme.

## Next executable gate and source-time constraints

R4A remains one connected retained-result gate: actual normal tools, synthetic outcomes, MCP, Code Mode, exec/background and child result sources plus model/archive/read/report consumers. A standalone store with no real callers is not completion. R4B semantic seed/atomic bootstrap and R4C durable delivery/epoch handling remain separate.

The next plan must include explicit source-to-envelope contracts, private capture/receipt handles, old-path retirement, closed event/reference validation, artifact source limits and all format/query/seed readers. It must also qualify:

- Exact 1,048,576 and 104,857,600-byte results, sufficient and insufficient quota, cold original digest, bounded model/page output and no extra full serialization in the streaming path.
- Actual ordered exec frames before the 64MiB collector discard, once-only getter/toJSON/body/finalize/post-hook behavior, source-limited Code Mode emission and preserved program result value.
- MCP content/structuredContent/isError and ordered media before success/error presentation, including arbitrary payload keys named image/images/audio.
- At least100 independently revisioned child/job 1MiB results, bounded fan-in and authorized pages without full body copies in metadata; no wake/claim completion claim from this retention evidence.
- Artifact write/index/metadata/pin and F1 issuance/receipt/install crash cuts, exact-identity recovery, source revocation, current authorization before body I/O, GC/clear refusal, concurrent ownership and index loss.
- Quote/emoji/NUL/deep data and final JSON bounds; independent Merkle tamper vectors and measured bounded I/O for a 32KiB page over a100MiB artifact.

Root will rebase the actual F1/result/version interfaces against accepted R2E and self-review the executable task before dispatch. This planning work does not advance R4, original27/43 decomposition, or release readiness. Existing renderer, historical failure and R6 full-history scalability obligations remain visible.
