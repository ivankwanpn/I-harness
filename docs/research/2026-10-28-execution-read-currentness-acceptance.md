# O1 Task2a execution read assertion integration

2026-10-28 HKT. Accepted bounded Task2a from NATIVE `247741b3` and `94a6bf4212dfeba624d4e257fb8fb32644fa156c`, integrated into MAIN `40b86b78` and `74abe47f`. The integrated packages tree is `59bffee0133a6b4c1d4f32b07ba920e52184bc72`, identical to the reviewed donor at that checkpoint.

The existing execution read accepts an optional private synchronous currentness assertion. It checks the original read entry, real profile/snapshot await boundaries, selected owner and final fully constructed DTO immediately before return. Ordinary callers that omit it retain prior validation, bounds, pagination and Stop behavior. Real errors, including falsey errors, are not converted to resets or swallowed. The read does not load/recover a session or create an assembly.

Independent Sol review found no actionable defect in the two-file slice. Root reran the12 currentness/bounds tests and existing reference-authority test on the integrated MAIN: **13 passed**, source checks unchanged. Evidence: `.superpowers/sdd/2026-10-27-execution-surface-observation/task-2a-baseline-20261028/048a8c2ea8064cf38cd565fb7319729a/`. Donor type and selected existing read/Stop checks are separately recorded; overlapping populations are not added into a new total.

This supplies assertion placement, not its full production authority. Task2b still needs a genuine retained observation/read lifetime, broker ownership, source invalidation, Gateway leases, SDK/bridge and Desktop subscription integration. The proposed retained-owner design has unresolved dependency cleanup, same-close retry and profile-subflight issues and a separately explicit idle cold-lock policy cost. No production subscription capability or zero-poll claim is made.

The broader existing execution-surface regression command also has two independently reproduced original job-output failures. They remain open and have a separate repair design; Task2a does not reinterpret or waive their expected full-output behavior.
