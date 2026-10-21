# Original-range review and root audit records

These are exact copies of root/reviewer records outside the immutable writer evidence trees. They describe their recorded source freezes, not permission to rerun old sealed writer scripts. No product execution is performed by the root audit scripts; changing source later can correctly invalidate a historical current-file assertion.

- `review.md`, `supporting-source-evidence-notes.md`: original91d8fef0..a4b31812 independent review; two reproduced findings.
- `fix-review.md`: same reviewer throughcef5c6e2/06c4abe4; F1/F2 closed, whole R4A not ready for unresolved host-close qualification.
- `evidence-audit.*`, `source-audit.*`, `fix-evidence-audit.*` and audit-attempt notes: the reviewer's exact independent records, including failed static-navigation assumptions.
- `a6-root-audit.mjs/json`, `a6-semantic-audit.mjs/json`: root original A6 filesystem/receipt audit and independent literal/host-observation calculations.
- `correction-root-audit.mjs/json`: root correction filesystem/receipt/source/copy/selected observation audit.

Writer portable proof and source maps remain in their separately tracked delivery directories; raw sealed roots remain local. The main [checkpoint](../2026-10-21-context-r4a-review-checkpoint.md) distinguishes product behavior, test/evidence scope and the unresolved failure. Reports intentionally preserve actual local paths and historical gates. No merge, push, tag or release is implied.
