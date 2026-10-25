# Windows native event owner — scoped source/integration acceptance

The reviewed N2 source and asset range4bb009a5..82ef4e93 is accepted and integrated in MAIN through cf753bc9. It consists of31 changed files and the complete reviewed implementation/fix sequence, including exact checkout-byte packaging. Forensic commits a07f220e/9f34e988 were not integrated.

The Windows execution owner uses actual event/wait registrations and owned queue transitions for healthy execution. Existing stop-only cancellation/backoff and honest early MSYS observation failure remain distinct. The original connected review, cancellation/lifetime fixes, qualification-record repair and canonical-byte repair retain their separate source/binary evidence; this acceptance does not relabel an old binary run as a new one.

The [same-reviewer integration verdict](windows-event-owner-20261025/main-integration-review.md) is PASS for the scoped Windows event-owner source and integration obligations. It found no remaining concrete N2 blocker within that scope. Root and reviewer confirmed all31 donor/MAIN Git blobs, all30 native source hashes plus raw protocol bytes, the exact helper/template/record identities,2896 unchanged tracked source identities and all five integration log hashes.

Actual MAINcf753bc9 checks:

- Native assets/provenance verification passed without newline normalization.
- All11 Windows PSEC package test files passed:120/120, including a fresh Git-byte package copy, production verification and actual helper probe.
- Authenticated executor ownership, retained-batch continuation and completed/running close qualification passed10/10 across three files.
- PSEC and session-executor typechecks passed; source was unchanged across all checks.

The [integration receipts](windows-event-owner-20261025/integration.json) record exact commands, environment, source and exits. Raw logs/source manifests remain under `.superpowers/sdd/2026-10-24-windows-native-event-owner/integrated-cf753bc9/`; the fresh checked copy is `.tmp/git-byte-package-pQOhtC`. This is source/fresh-copy integration, not installation into the user's running app or a released package.

Helper SHA256 is `c8e8f3354c1ca42f1971b2fc0dbf5da0ec1b7112b23cd39dde327be9c59c7392`; MSYS template is `334994eec6217a985841b65b3d81553556f406ac6baf7de8893bb123805b8b6d`; protocol is `e795fc9cae6e26d45ecdba592e13f84eccc803bae141ffc37f6acd3d0bd2912c`.

Qualification remains **experimental, historical-one-host and incomplete:39 pass,0 fail,4 unsupported**. No unsupported capability is enabled by these passing tests. Earlier controlled lifetime/pressure results retain their original binary identities and the equivalence limits in [the source-review checkpoint](2026-10-25-native-source-review-checkpoint.md).

The [accepted same-invocation recovery mechanism](2026-10-25-retained-batch-continuation-acceptance.md), its required21/21 session gate and the current authenticated consumer checks close the earlier integration holds. Historical003's first trigger remains unknown; this is not a historical-cause, source-independence or timing-stability claim. The close-qualification evidence-I/O P3 stays visible for final whole-branch review.

Full internal event delivery/receivers/UI/source gates, other-platform evidence, remaining context/instruction work, fixed-version packaged verification and release remain separate. Product is still0.1.13-rc.1/Session12; no push/tag/release is performed here.
