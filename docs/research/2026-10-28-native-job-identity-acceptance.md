# Native background job identity and passive inspection — J1

2026-10-28 HKT. The bounded J1 repair is accepted after independent review and the same reviewer's correction review. Donors `ea75dda02b2f7bf566095e4d32672847dfffe6ad` and `64499fe58cf5e21a8141a8c6c1119513f7ca56c5` are integrated into MAIN as `9554f1f9` and `66fcc069b13ba183771653feb3f9651dd0147bf2`. Root verified that all15 changed file blobs equal the reviewed candidate. Product0.1.13-rc.1 / Session13 is unchanged; no publication is part of this checkpoint.

The original job owner allocates an immutable instance UUID before native admission and carries it through background submission, foreground promotion, repeated views and registered shell results. Short job and frame source IDs can repeat after service restart; the new instance distinguishes those actual executions even when output bytes also match. It identifies an execution and does not grant read or cancellation authority. Genuine native services return it unconditionally; compatibility-facing custom service ports may omit it, without manufacturing historical provenance.

Passive job views use the same original owner/access checks and do not start result observation or recovery. The actual assembly's background projection uses that passive path and preserves the native truncation flag in addition to its own display clipping.

The first review found a concurrent collision gap: two equal forced allocations could both launch before either job published, then the loser rejected without an addressable job. The correction reserves pending tokens synchronously before admission, transfers them to the original Job on publication, and releases settled unpublished foreground or failed-launch reservations. Incomplete original cleanup retains its reservation until successful disposal. The causal test uses two distinct controlled native receipts, proving the losing duplicate never enters preparation while the winner remains controllable. Completed foreground tokens do not accumulate in a lifetime-wide set.

Root validation on the integrated MAIN:

| Scope | Result |
| --- | --- |
| Original identity, concurrent reservation, cleanup and passive recovery | 19/19 |
| Actual registered shell background/promotion identity | 6/6 |
| Actual retained-background assembly projection and scoped execution | 6/6 |
| Exec, shell and session-executor type checks | Each exit0 |

Every run used direct installed Node/Vitest/TypeScript, exact package CWD, sequential worker limits and six new isolation roots. The369 listed relevant source/test inputs were unchanged before/after; this is an explicit source population, not a complete third-party closure. Evidence is under `.superpowers/sdd/2026-10-27-execution-surface-observation/job-output-j1-root-integration-20261028/`, including the runner, source-binding.json and six run directories. Test runs are `46b046aac70b4dd2aefd3e2c59f5a0c1`, `413dac08132f4a31b420a40d2f150192`, and `c991816cc2174b699b0273882241c906`; type runs are `c0f2f092d69a434bad57c24c5d4e84ba`, `074e11088c7f42a8b99f1dbfecd03256`, and `263f611e7d914acbba9d11c2427a30a3`.

The historical shell-promotion suite still has six saved-result-shape failures. Root independently reproduced the same six names/assertions on unchanged baselinea9877bd3, with seven passes across the exact three-file selection; its365-input source population was unchanged. Evidence is `job-output-j1-root-baseline-20261028/948d3102dff64bc0ae3fd440c1e7dbe4`. This establishes the observed baseline, not a passing suite or proof of assertions hidden behind those failures. The old tests and failed receipts remain intact.

Full raw channel output/summary, instance-bound continuations, cold catalog hydration, Desktop historical selection/control and Code Mode full-output qualification are subsequent checkpoints. The original execution-surface two-RED baseline remains open and unchanged. J1 does not resolve or waive these full-output failures, complete O1, or certify an entire releasable version.
