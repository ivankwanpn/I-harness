# Settlement registration adapters — Task3 bounded acceptance

2026-10-28. Task3 of the [Code Mode owner-lifetime plan](../superpowers/plans/2026-10-28-code-output-owner-lifetime.md) is accepted after fresh independent review. Candidate4050012f680a728f0d838adf52ab31fd376f3b03 was integrated as041d961d316948c24972b79129c4aec0510c2e02. It changes nine test-only files, including the shared control helper; no production adapter or constructor needed modification.

Actual consumer installers now retain the original action receiver, complete registration tuple, exact checkpoint descriptor and returned source. The two source clones were removed. Narrow ordinary/delegated fact-source APIs remain unsupported for checkpoint and do not gain parent authority.

Two existing fixtures intentionally instrument lifecycle drain. Their pre-drain gate and post-drain/pre-retirement failure remain at those exact phases. Moving the error after a successful source.close would have stopped testing retained source ownership, so that alternative was rejected. The shared controls use the actual installers and real checkpoint/close/lifetime behavior rather than a second spy-only adapter.

The reviewer verified twelve registration RED/GREEN cases, two lifecycle phase controls, exact nine hashes/blobs, preserved type-helper setup failures and their concrete-type correction. Final saved affected results are Core-Agent87/87, Executor36/36, Team87/87 and all six required typechecks. These overlapping scopes are not added into a whole-version count. All24 invocations used six distinct new roots each and the prescribed direct tools.

Root integration confirms all nine blobs and the entire package source tree match the reviewed candidate; only separate root documents differ. No redundant runtime was replayed for that exact test-only integration. Records are in `.superpowers/sdd/2026-10-28-code-output-owner-lifetime/task-3-evidence`, `task-3-review.md` and `task-3-root-integration.json`.

Task4 must now qualify the actual mounted delayed-error path and original immediate-abort counterexample on this integrated source. Component/adapter acceptance alone is not proof that the historical long-session failure, complete event delivery or release is repaired.
