# N2-16 checkout/build packaging repair — same-reviewer review

Reviewer: independent GPT-6.1 Sol, 2026-10-25.

**Focused specification and quality verdict: Approved. Evidence verdict: sufficient for the scoped N2-16 repair. The fresh-checkout packaging blocker is resolved.** No new actionable source or identity defect was found in this repair. This is not full N2/version, integration or release acceptance. The separately owned authenticated Code Mode/003 gate remains open and is not changed or graded by this review.

## Scope and causal defect

Reviewed range:

`4a0ddfe4d79708da45db1040afb412978738196b..82ef4e93d52360e9d1d5a842e911404064999c02`

Exactly eight psec files change: package attributes, build owner, two new tests, rebuilt helper/manifest, new qualification history and new qualification record. Native source and protocol Git contents and the4a consumer fixture have no content delta in this range. I reviewed the frozen package/patch, committed source, N2-16 ruling, report, relevant RED/GREEN/build/qualification/fresh-copy evidence and new archives.

The original blocker is real. The old HOST protocol/native worktree byte strings contained CRLF while Git stored LF. Old runtime/source hashes described those worktree bytes, so a package copied from actual Git bytes failed production verifyHelper before launch. Earlier worktree/hash checks and CRLF-normalized source comparisons were insufficient for checkout/package acceptance. This repair is assessed on **raw Git and file bytes**, without a normalization waiver.

No builds, tests, native runtime, helper probes, process experiments, Git mutations, product edits or subagents were performed by this reviewer. This report is the only file written. Protected untracked Gateway data was not accessed. Recorded writer executions below were inspected, not rerun.

## Build guard and attributes

At `scripts/build-native.ps1:10-27`, the original owner now computes the native input enumeration once and uses it both for preflight and final provenance. The list covers Cargo files, recursive native/src inputs and direct native/msys files. Protocol is checked separately and retains its exact runtime digest. CRLF pairs are detected directly in raw byte arrays with a path/offset error.

The guard runs before compiler invocation, controlled output creation, bridge digest updates or shipping artifact writes. It does not rewrite files, invoke Git, require clean/staged/HEAD equality, alter runtime verification or accept an otherwise mismatched digest. Legitimate new/edited LF inputs are allowed. BOM and lone-CR bytes are not silently stripped or reinterpreted; the guard addresses only conversion-sensitive CRLF. Upstream notices and generated artifacts are outside the owned text preflight and retain their exact bytes.

The same `$sourceFiles` list drives final raw source hashing, removing divergent preflight/provenance enumeration. The original compiler/SDK pinning, bridge import checks, normal-versus-controlled build guards and original generation owners remain intact. No native lifecycle or protocol meaning changes.

Package-local `/artifacts/** -text` and `/native/msys/notices/** -text` explicitly override the package's broader text rule. They preserve artifacts and upstream notice bytes through Git staging/checkout, including mixed newlines. The manifest whitespace diagnostic rule allows CR-at-EOL without changing data or disabling its hash checks; ordinary trailing-space diagnostics remain listed. The Windows build owner still emits its actual manifest bytes, now preserved as committed bytes rather than normalized after generation.

The tests exercise protocol, native C and a new recursive Rust input rejection before controlled output exists, unchanged byte snapshots, accepted LF/uncommitted inputs with BOM/loneCR preserved, and exact mixed artifact/notice bytes through an isolated Git index and checkout. Their absent SDK is intentional so guard tests do not execute a compiler. The positive LF test proves passage through the canonical guard to normal SDK validation, not a fictitious successful native build. Actual127 supplies the separate successful original-owner build.

The new checkout test deliberately reads index bytes, documents that the export candidate must be staged, copies the package and invokes source verification, the copied production verifyHelper and an actual checked-helper probe. That export-test precondition is separate from the build owner's no-Git requirement. Final139/140 use committed HEAD bytes, so final acceptance is not based only on a possibly stale index.

## Exact final bytes and derivation

I independently checked all77 review-body files against their freeze hashes and recomputed their raw Git blob object IDs, matching actual82ef4e93 tree entries. This includes binary assets, manifest, protocol, native inputs, notices and qualification/history bytes; no newline normalization was used. All30 native manifest source entries and the separate protocol digest match the packaged raw bytes. The139 audit likewise has31 raw Git/working/manifest equality rows with zero failures.

Measured final identities:

| Item | SHA256 |
| --- | --- |
| Rebuilt helper | `c8e8f3354c1ca42f1971b2fc0dbf5da0ec1b7112b23cd39dde327be9c59c7392` |
| Normal MSYS template | `334994eec6217a985841b65b3d81553556f406ac6baf7de8893bb123805b8b6d` |
| Protocol | `e795fc9cae6e26d45ecdba592e13f84eccc803bae141ffc37f6acd3d0bd2912c` |
| Exact generated/committed manifest | `dfae9469f68532b3b8388e0518ec1cefc6a1a9c69489262b9b948754b5a9b673` |
| New128 raw qualification | `d68fbeb08604e50aa089578eaef2355e200241e4cc69fc84b80065955bb8bf44` |
| New qualification record | `6f3c411f9e405dd867170e5f7e18a913b1f4b270af243f5c4cca592cb50681a1` |

The original owner127 rebuilds the helper; its measured identity changed. The normal bridge template is independently measured byte-identical. New128 runs actual standard qualification on the new helper/protocol, with43 unique case identities and39 pass/zero fail/four unsupported, exit2. Its embedded manifest equals the final manifest and its helper/observedAt/raw hash match the new record. Corrected exact43-case owner129 derives that record from128, not historical069.

The old product record is retained byte-for-byte in `qualification-history/2026-10-25-before-canonical-inputs.json`, SHA `0a62f658056ab05ce379583b46c3196716c233c06e661a47b8919a5e8ba1ec49`. Original069 and earlier records remain historical and unchanged. The new record remains experimental, historical-one-host and incomplete, with four unsupported cases and the existing standard-only scope. No old helper observation is relabeled as a new-helper execution or hash-blessed into acceptance.

Runtime and source verifiers continue to compare exact bytes. They were not modified to normalize CRLF on either side of a digest comparison. Actual140's HEAD-byte copy passes source verification, production helper/protocol verification, an actual checked-helper --probe exit0 and the original package-copy owner. Probe output retains experimental assurance, PSEC PTY/read-isolation refusals and the existing capability profile; the probe itself is not a workload qualification.

## Recorded causal and covering evidence

- 122 preserves the original bad byte strings and assets.123's fresh Git-byte package rejects with protocol hash mismatch before helper launch, exit1.
- 124 records guard/attribute RED4 failures/one pass.125 records5/5 GREEN; byte preservation, ordering and exact checkout assertions pass without compiler execution.
- 127 original canonical build succeeds;128 new standard run remains39/0/4 exit2;129 derives only from that new input.
- 130 records89/89 focused passes: build-input5, record-owner48, integrity9, record-identity2, public driver13, MSYS admission5 and advanced MSYS7.132 types pass.
- 133 records51 native passes on canonical inputs/new helper fixtures.134 records34 native-smoke passes, including blocked input/output cancellation, EOF, retention, console/ConPTY and PSEC filesystem/refusal paths.
- 136 uses production decoders on the new default helper. Three repeats obtain actual tree/I/O before any new release or control EOF in8/11/7ms. Eight unconfirmed input IDs per repeat are not fabricated ACKs.
- 137 records the inherited early MSYS fallback at2047ms: logical root null with observation error, factual tree0, outputAbandoned:true/discarded0/errors[], resource ACK, helper0 and actual reader joins. This is not child ROOT137, normal EOF or proof of full output preservation.
- 138 verifies/copies the exact new helper/template/qualification/source assets.139/140 provide final committed-byte equality and actual fresh-copy verification/probe/copy results.

The new142 evidence manifest contains2,567 file entries. I verified those new entries with no hash mismatch; I did not rehash the unchanged15336 historical inventory merely to inflate an audit count. The17 complete fixture ZIPs contain790 uncompressed source-inventory entries. I independently read and hashed every archived entry, with zero size/hash mismatches, and matched archive identities. This agrees with the recorded143 archive verification.

The141 MAX_PATH partial freeze remains a preserved failed attempt, not accepted as a complete fixture copy. The142 short-path ZIP inventory supplies the complete frozen fixtures; no lost file is synthesized and no product byte was changed to work around that copy failure.

## Evidence and acceptance boundaries

New c8e8 binary observations are the covering checks explicitly listed above. Earlier300348 controlled lifetime/fatal/idle, ConPTY VT and other pathological records keep their original helper identities. Unchanged committed native logic and byte-identical normal MSYS template support stated source/template equivalence, not a claim that those older controls executed c8e8. The prior invalid-fixture, parser, injected-versus-actual failure, bounded idle and physical PID/churn/exhaustion limits remain intact.

N2-16 is satisfied for this package: raw Git export bytes, exact provenance/runtime verification, original-owner rebuild, new qualification/record and fresh-copy backend probe are connected without a normalization exception. No corrective change to the eight-file package delta is requested by this review.

The authenticated Code Mode/003/L1 issue is separately Root-owned and remains open. This repair does not edit that fixture, its owners, retention policy, assembly or persistence, and does not provide its missing acceptance evidence. **Do not infer full N2/Task6, version, integration or release approval from this scoped packaging approval.**
