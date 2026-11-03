# N2-16 canonical checkout/build repair

Status: **fresh-checkout blocker repaired and exact new candidate frozen for same-reviewer review; no integration/release claim**. Root's003/Code Mode/L1 work is outside this repair. The handed-off HOST branch is `codex/native-consumer-identity-20261025`; no branch was created, renamed or switched by this repair.

Repair range: `4a0ddfe4d79708da45db1040afb412978738196b..82ef4e93d52360e9d1d5a842e911404064999c02`, exactly eight psec package files. Root's committed/reviewed4a consumer fixture remains unchanged. Full accumulated N2 range remains based at4bb009a; Root owns the separate consumer correction/disposition. No MAIN product runtime or source was used or edited. Protected untracked Gateway diagnostic remained unread, unhashed and untouched.

## Causal blocker and byte preservation

Root's protocol/source-checkout audits and our122 reproduce the defect. HOST protocol raw CRLF SHAfc0e8472 matched the old manifest, but committed Git LF SHAe795fc9c did not. Six native inputs likewise had raw HOST CRLF hashes in provenance while Git stored LF: api.h, bridge.c, dispatch.rs, event_drain.rs, notifications.rs and running.rs. Their CRLF→LF bytes equal committed Git exactly. This is a real package reproducibility failure; it is not the earlier003 fixture issue.

Stage122 preserves the original seven input byte strings and original package assets/record/attributes/build owner under evidence/qualification/packaging-repro. Stage123 creates a fresh HOST-owned copy directly from committed Git bytes and invokes that copy's production verifyHelper. It rejects with `Windows helper protocol hash mismatch` before launching a helper. The RED is recorded as exit1.

Stage126 converts only the seven owned CRLF inputs to their already-committed LF bytes, after checking each original raw SHA and exact normalized equality with Git. It neither strips/rejects loneCR/BOM nor rewrites any upstream notice or artifact. The unchanged notice/artifact hashes are preserved in126. These working-tree normalizations produce no native/protocol Git content change:139 proves their raw committed content is unchanged from4a.

## Build and Git attribute correction

The original build owner now enumerates its existing native inputs once, before compiler invocation or any controlled output/artifact write. The same list supplies both the nonmutating CRLF preflight and final raw-byte source hashes. Protocol is included in preflight separately and retains its exact runtime hash. The guard reads raw bytes and rejects CRLF pairs with the exact path/byte location. It does not convert inputs, ignore a mismatch, call Git or require clean HEAD equality. Legitimate LF edits and new recursive LF files can build.

The package's `* text=auto eol=lf` overrode root -text rules. Explicit package-local -text rules now cover all artifacts and native/msys/notices. Mixed-line-ending artifact JSON and upstream notice fixture bytes survive both Git staging and a fresh checkout exactly. The original Windows build owner continues to emit its exact CRLF manifest JSON; it is not normalized after generation. A manifest-only whitespace attribute accepts CR-at-EOL for diagnostics while retaining the ordinary trailing-space checks. This affects neither hashing nor verification.

The permanent checkout-integrity test reads Git index bytes into a fresh package, compares all pinned source/protocol/asset/notice/record bytes with the candidate, invokes source verification and the copied production verifyHelper, then executes the checked helper's actual --probe. Its comment explicitly requires staging the export candidate.139/140 additionally use the final committed HEAD, not merely the index.

## New candidate identity and new qualification

The original build owner127 compiled the canonical source bytes. The helper changed and was measured; the bridge template was independently measured byte-identical. No old runtime result was relabeled.

| Item | SHA256 |
|---|---|
|New helper|`c8e8f3354c1ca42f1971b2fc0dbf5da0ec1b7112b23cd39dde327be9c59c7392`|
|Normal MSYS template|`334994eec6217a985841b65b3d81553556f406ac6baf7de8893bb123805b8b6d`|
|Canonical protocol / raw committed Git bytes|`e795fc9cae6e26d45ecdba592e13f84eccc803bae141ffc37f6acd3d0bd2912c`|
|Exact generated/committed manifest bytes|`dfae9469f68532b3b8388e0518ec1cefc6a1a9c69489262b9b948754b5a9b673`|
|New actual128 standard raw results|`d68fbeb08604e50aa089578eaef2355e200241e4cc69fc84b80065955bb8bf44`|
|New experimental qualification record|`6f3c411f9e405dd867170e5f7e18a913b1f4b270af243f5c4cca592cb50681a1`|

Stage128 runs the original standard owner on this new helper/protocol and records39pass,0fail,4unsupported, exit2. Actual evidence originates at HOST/.tmp/sandbox-redesign-qualification-bXx39T and is copied unchanged into packaging-repro. Stage129's exact43-case derivation owner produces the new record only from128 and the matching manifest/source/OS/assets. It remains experimental, historical-one-host and incomplete with the same source-family labels and standard-only scope. The previous0a62 record is preserved byte-for-byte as qualification-history/2026-10-25-before-canonical-inputs.json. Original069 is not reused, changed or relabeled.

## Covering checks on the new helper

| Stage | Observation |
|---|---|
|123|Fresh committed-byte package RED: exact protocol verification refuses before probe.|
|124|Canonical guard/attributes RED:4fail/1pass. Original owner lacks the requested early CRLF rejection and package attributes convert exact artifact/notice bytes. No compiler runs; fixtures use an intentionally absent SDK.|
|125|5/5 GREEN: protocol/native/new-recursive CRLF rejection before output creation, byte preservation, accepted legitimate LF edits plus exact loneCR/BOM, Git stage/checkout exact artifact/notice bytes.|
|127|Original canonical build succeeds; helper c8e8 measured, template334994 measured unchanged.|
|128|New actual standard43 observations:39pass,0fail,4unsupported.|
|129|New record derives from128; prior record preserved.|
|130|89/89 pass: build-input5, record-owner48, integrity9, record-identity2, public-driver13, MSYS-admission5, advanced MSYS acceptance7. All runtime cases bind c8e8.|
|131|Fresh index-Git-byte package, exact pinned bytes/source verification, copied runtime verification and actual --probe pass.|
|132|Types pass.|
|133|Original native Test owner51/51 pass with canonical inputs and new shipping helper fixture; exact test executable retained.|
|134|Original native smoke owner34/34 pass, including cancellation, blocked input/output, EOF, retained trees, console/ConPTY and PSEC filesystem/refusal routes.|
|136|Three strict default-helper cancellation repeats use production decoders. Actual tree/I/O complete before any new release/control EOF in8/11/7ms. Logical root remains null/error; outputAbandoned:true, actual resource ACK/helper0. Eight unconfirmed queued input IDs per case are not fabricated ACKs.|
|137|New helper's inherited early MSYS cut completes at2047ms under original grace: null root + observationError, factualtree0, outputAbandoned:true/discarded0/errors[], resourcesReleased:true, helper0 and readers joined. Not child ROOT137 or normal EOF.|
|138|Original asset-copy owner verifies/copies c8e8/template334994/new record and sources into a fresh owned fixture.|
|139|Final committed HEAD byte copy77files; all30 native manifest inputs plus protocol match raw Git exactly, not LF equivalence. Assets/notices also match actual committed bytes. Native/protocol Git content unchanged from4a.|
|140|Final HEAD-byte package source verification, production exact runtime protocol/helper verification, real checked-helper --probe exit0, and original package-copy verification all pass.|

Every runtime/setup result keeps its original source snapshots, argv, CWD, timestamps, exit and artifact identities. A preliminary git add used a repository-relative path from package CWD and failed pathspec without mutation; it was corrected from HOST root. No compiler or runtime success was inferred from that shell failure. Freeze141's deep fixture-copy attempt hit Windows path-length errors3/206; its script and partial copy remain preserved, and original fixtures/product files were unaffected. Freeze142 preserves complete fixtures in short-path ZIP archives with per-entry hashes instead of repeating that deep path layout.

## Scope/evidence distinctions retained

The new c8e8 helper receives the covering native/public/MSYS/standard/smoke/source/export checks listed above. Earlier controlled115/095 lifetime/fatal counters, earlier ConPTY VT interpretation,049 raw pressure and other300348 runtime records retain their original bindings. They are not reported as executions of c8e8. The committed native logic is unchanged and the normal MSYS template is byte-identical; those facts support explicit source/template equivalence, not fabricated new-binary OS observations.

All earlier parser limitations, actual-versus-injected failure distinctions, bounded idle scope, physical PID/churn/exhaustion limits, lost040 aggregate, null MSYS root/error behavior and four unsupported PSEC/MSYS routes remain as recorded. The root's consumer003/L1 disposition is separate. This packet does not alter public protocol, TransportExecutionHandle, policy/root/lifetime restrictions, ACL capability claims, Code Mode or persistence/assembly code.

The old116 and121 evidence inventories and all earlier raw records remain immutable. The repair inventory rehashes them and preserves the new before-byte proof, RED/GREEN, actual new qualification, exact binaries/manifest and final committed-byte/runtime/copy evidence. The same reviewer must assess the original build-owner guard, attributes, tests and new exact generated identities together before Root's final decision. No remote action, push, integration, tag or release was performed.
