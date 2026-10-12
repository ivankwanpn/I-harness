# Session progress, cache continuity and role discovery audit

This follow-up to v0.1.10 separates three observed concerns: executor settlement,
silent model requests, and low subscription cache reuse. The displayed child
task name `gateway-job-failure` was not itself a gateway error code. Usage records
also did not establish that Luna usage had been relabeled as Sol: the inspected
recent child launches selected `general`, which was configured to use Sol.

## Reference findings and implementation boundaries

- The local `codex-rust-v0.160.0` snapshot supplies evidence for subscription
  session/thread identity and per-turn sticky routing. IH keeps these private
  transport features on the authenticated official subscription endpoint. API
  key usage of Codex does not make the public Responses API a subscription
  endpoint. Parsing and usage normalization remain shared.
- The unchanged Todo render previously embedded an incrementing revision. The
  revision remains available for durable state; model-visible instructions now
  change only when their content changes.
- The local `opencode-fork-private-999.0.15` snapshot, particularly
  `packages/core/src/tool/task.ts`, `packages/core/src/tool/registry.ts`, and
  `packages/core/src/plugin/agent.ts`, describes role purposes and actual role
  identifiers to the model. IH previously exposed little beyond a `general`
  default. IH adds live discoverable role metadata while retaining omitted-role
  compatibility for saved calls. Model overrides remain user-owned.
- Earlier retry and floating-error references remain documented in
  [the recovery audit](2026-10-12-model-recovery-and-diagnostics.md). The follow-up
  adds bounded waiting and final settlement rather than another retry layer.

## Verification contract

Tests use fake models, isolated temporary profiles and local HTTP endpoints.
They check single physical-attempt ownership, cancellation, partial tool progress,
terminal error-body stalls, usage capture, protocol wire isolation, account/turn/
child boundaries, and direct/Code Mode role discovery. Desktop checks exercise
actual components at narrow/wide sizes and both themes. Release-wide results and
packaged artifact checks are recorded in the release manifest.

No real provider was exercised. The work does not establish a new live cache-hit
percentage, force a role mix, reconcile all differences with provider dashboards,
or rewrite historical usage. Provider dashboards can cover different requests
and use completion-time aggregation; matching one time bucket does not prove
full-account equivalence.
