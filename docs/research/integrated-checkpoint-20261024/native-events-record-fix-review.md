# N2-FR-01 focused correction — same-reviewer review

Reviewer: independent GPT-6.1 Sol, 2026-10-25.

**N2-FR-01: resolved. Focused source/spec and quality verdict: Approved.** No new actionable defect was found in the generator correction or its new regressions. The record-owner correction no longer blocks the N2 task. **Overall N2 integration remains held on the separate076 consumer fixture/verification gate; this report does not approve integration or mark N2/Task6 complete.**

## Reviewed scope and source identity

Frozen range:

`b074656a262b28c378f0b18acdbaf99f50c82803..e68b4fc32fefbd98b4857ca70e2e72cf004f6f33`

Exactly two files change:

- `packages/sandbox-windows-psec/scripts/record-qualification.mjs`.
- `packages/sandbox-windows-psec/test/record-qualification.test.ts` (new).

I read the focused report/package/patch, committed Git bodies and recorded117–120 evidence. Both frozen body files exactly match the committed e68b4fc3 bytes and freeze hashes: generator `c71d9b008a6fe02d5366031d04f31d7ccfd4bce16af7f1fded2d9d0d5095a18e`; test `1244f1f21473b3343bbe010738f3f6a7f0ce63b69fbdb7f89ef9386f94a333b8`.

HOST is reserved for the separate consumer test writer. I did not inspect or execute its current work, rerun tests/native runtime/builds, edit product files, mutate Git or spawn agents. This report is the only file written. The protected Gateway diagnostic was not accessed. The prior final review and its evidence remain unchanged.

## Finding disposition and new-breakage assessment

The old partial required-name lists are replaced with an explicit expected43 name/outcome Map. Each supplied row must have a unique expected name and its exact required outcome. Every expected name must then be present. Unknown names, substitutions, omissions, extras, duplicates, failed/unknown outcomes and count-preserving pass/unsupported swaps fail before record creation. The39/0/4 aggregate check remains an additional invariant rather than a substitute for case identity.

I independently compared both the generator Map and the test's43 transcribed cases to the immutable069 raw name/outcome set: both match all43 exactly. This closes the concrete missing `psec-job-cancel-timeout` plus `replacement-pass` path and the corresponding omission for the other previously unchecked controls. The four intentionally unsupported outcomes remain required as unsupported.

The existing artifact/source/path/OS checks, source coverage check, raw evidence hash, observedAt validation, exclusive output creation and experimental/historical-one-host/incomplete record labels are unchanged. Validation failure cannot reach the write. No qualification workload, public protocol, policy/capability, retention owner or result meaning changes. The explicit Map intentionally binds this generator to the original standard matrix; future matrix changes require deliberate owner/test updates instead of silently accepting a new same-count set.

The tests invoke the actual Node CLI in unique owned fixture directories and preserve input/stdout/stderr/status/output-existence evidence. Their metadata is labeled CLI validation data, not claimed native execution evidence. Substitution controls cover all43 cases; additional missing/extra/duplicate/status-swap controls and the valid matrix cover the new branches. Existing source/artifact identity and shipped-record consumer controls remain separate checks.

## Recorded causal verification and bindings

The preserved receipts/logs record:

- **117 RED:** original b074 generator with new tests,22 failed /26 passed. The22 formerly unrequired pass cases could be replaced while still writing records. This is the original defect, not a fabricated failing implementation.
- **118 GREEN:** corrected generator,59/59 passed, including48 record-owner cases,9 integrity cases and2 qualification-record identity cases. All43 same-count substitutions reject without output.
- **119:** focused typecheck exits zero.
- **120 valid:** original immutable069 evidence succeeds and writes a separate record byte-identical to the existing product qualification record, SHA256 `0a62f658056ab05ce379583b46c3196716c233c06e661a47b8919a5e8ba1ec49`.
- **120 negative:** actual069 copied with only the reported cancellation case name replaced preserves39 pass/four unsupported, exits1 with `unknown standard observation: replacement-pass`, and writes no record.

I checked16 selected new package/report/receipt/log/raw-result/fixture-observation inventory bindings with no mismatch, checked the original069 identity and valid120 record hash, and verified the prior116 manifest hash against the fix freeze. The121 inventory records complete revalidation of the prior15336 entries; I did not redundantly rehash those unchanged entries or claim an independent rerun of117–120.

Native source and build-owner enumeration are unchanged and exclude this script and test. Git's exact two-file delta, the preserved manifest coverage, and120's unchanged source/artifact/record bindings support reuse of the earlier native qualification identities for this validation-only correction. No helper/template regeneration or native runtime repetition is required solely for these two edits.

The helper remains `300348687570c71e3012545442336f807f8e7f66478d6eaaf1d35e016d70e68d`; normal template remains `334994eec6217a985841b65b3d81553556f406ac6baf7de8893bb123805b8b6d`; raw069 remains `6cbfb6605bffd49a53549f47d623c32a51f0cb4fd7abb6c4a3947d542513eb4d`. The historical record is unchanged, and the valid120 output does not overwrite the product record. No stale native identity is blessed by this correction.

## Separate076 integration gate

Root's new `consumer-076-diagnosis.md` supplies a concrete source/data diagnosis: the assembly has an actual auto-acquired retention host and actual committed child artifacts; the parent test enters through identity-less `tools.execute`, producing an undefined authenticated result-source descriptor and honest unsupported-owner recovery after publication. This refutes the missing-storage hypothesis. It is not a pre-N2 passing-baseline result or a claim that every native behavior is equivalent.

The separately authorized fixture correction and its positive/negative/visibility/lifecycle checks are not part of e68b4fc3 or this focused review. They still need their own frozen result and review. The original076 failure remains preserved. I do not count its unexecuted receipt/visibility assertions as passed, accept a fake retention adapter, weaken the missing-source refusal or infer final consumer success from the diagnosis alone.

With N2-FR-01 closed, the prior final review's native source/assets/evidence assessment stands without a new native blocker from this script/test delta. **Integration and final N2/Task6 completion remain pending the separate consumer-gate evidence and resulting review decision.**
