# Sandbox production migration and distribution

Date: 2026-10-07 (Asia/Hong_Kong). Implements the already approved package redesign after reviewed foundation, transport/supervisor and Windows driver phases. Use the existing feature checkout. Reference source trees stay readonly; no accounts/services/elevation/reference ACL mutations, policy fallback, or default promotion of preview PSEC.

Production migration map: `.superpowers/sdd/2026-10-07-sandbox-foundation/runtime-migration-map.md`. This identifies actual launch/disposal/authority sites; use it rather than recrawling the repository.

## Binding decisions

- `exec` owns one supervisor for an assembly; shell and terminal consume that same service. Standalone shell registration may compose a service only when none was supplied. `terminal` owns view/cursor/ring records, never a separate IPty/process lifetime.
- `runBackground`, `killJob`, terminal open/signal/close/resize/dispose become awaitable. A running ID is exposed only after commit. Cancellation is pending until actual tree/I/O/resource settlement; incomplete cleanup remains visible and owned. Promotion retains one handle and existing output, never respawns.
- Native unrestricted Windows execution uses the explicit native Job backend. PSEC is explicitly selected (`IH_WINDOWS_SANDBOX=psec`, recorded as experimental); default confined Windows remains the named legacy backend. Missing/failed PSEC refuses. A legacy runner adapter must expose its root-bound lifetime and unsupported PTY/retained-descendant capabilities honestly; it cannot invent native observations.
- Linux bwrap and explicitly unrestricted POSIX drivers retain the existing supported mode behavior, with process-group/namespace observation limitations documented. Their capability/assurance must not claim PSEC or universal security. Unsupported confined platforms refuse. Platform spawn/node-pty lives in drivers under sandbox-local/native package, not exec/terminal.
- Exact shell executable/dialect/argv/argumentEncoding and granted per-call mode are kept. Cwd never grants authority. Capture standing mode/project/role revision in the compiled policy even when a per-call grant selects a different mode; revalidation checks that original authority generation, not an automatically refreshed grant.
- Actual owner comes from trusted dispatch `ToolExec.sessionId` and durable coordinator parent lineage. Add an exec caller scope (`AsyncLocalStorage`) API used by an assembly tools/execute cascade after trusted owner resolution; descendant/nested tools inherit that frozen owner. This covers shell, file search, workflow and Code Mode without copying parent closures into parent ownership. Command JSON never grants its own session identity. Human Desktop terminals retain explicit `desktop-user` ownership and unrestricted host authority.
- Project scope broker publishes an explicit `AuthorityState` getter. Only unbound state may use the configured workspace. Missing catalog for an existing project binding is revoked; inaccessible/closed services are unavailable. Keep existing display getters for compatibility, but they must throw for revoked/unavailable state rather than returning undefined. FS writes, approval roots/identity and process policy consume the same authority source.
- Catalog/mode narrowing publishes its new revision synchronously, immediately fences affected supervisor owners/preparations, cancels incompatible handles and awaits all rollback/tree/drain/release before acknowledgement. Compatible policies and unrelated owners continue. Failed cleanup rejects the acknowledgement and keeps admission blocked; retries are explicit. Restored mode history cannot escalate current run. Assembly disposal uses supervisor disposal before driver composition cleanup, with no raw Windows exception in assembly.

## Task 1: Local and explicit legacy backend composition

**Files:** sandbox-local driver/composition modules, public exports, tests/README/package dependencies; minimal sandbox-windows-acl public adapter support only if required for confirmed legacy owner facts. Workspace lock changes only declared dependencies.

- [ ] Produce `createLocalExecutionBackends` with `select(policy,transport)` and async `dispose`. Inject Windows PSEC/unrestricted and explicit legacy adapters from public packages. Selection happens once before preparation; no postfailure backend change. Dispose owns and reports driver teardown.
- [ ] Add POSIX Node pipe/PTY transport in driver modules using bounded single-consumer queues, explicit env/cwd, process group ownership and existing bwrap policy generation. Declare actual assurance/limitations. Node-pty dependency moves to driver; no cross-package private imports.
- [ ] Legacy Windows runs the existing confined runner under the native unrestricted Job owner, preserving runner failure classification and grant lifetime. Re-label receipt to the actual legacy policy/backend while retaining the underlying owned handle and observing its Job. No protected/reference grants are changed. Unsupported PTY/retain-tree requirements refuse; historical background presentation may remain root-bound and must be documented.
- [ ] Fake adapter capability/ownership/rollback tests and real existing shell controls. Do not infer process-tree emptiness from wrapper close. Commit only task files; independent review.

## Task 2: Exec service uses the shared supervisor

**Files:** exec/src runtime/service/collector/caller-scope modules and index exports; affected exec tests/README; shell/src registration/background consumers/tests; session-executor/scoped-exec async forwarding; subagent shell-cancel consumer if needed.

- [ ] Replace ordinary and streaming raw spawn paths with one launch through reviewed supervisor. Bind detached exact ProcessSpec, requested lifetime and compiled policy before async setup. Bind environment once (Windows key case handling), preserve empty explicit environment at backend seam.
- [ ] Keep OutputCollector spill/tail, UTF8 streaming, bounded stdin, stdout/stderr counters, output-limit/consumer stop, timeout, external abort and retained-output behavior. One output consumer feeds presentation/collectors. Continue draining after cancellation according to explicit discard limits; no output loss at promotion.
- [ ] Await background commit/cancellation; keep complete settlement separate from root exit. Job records are views of supervisor-owned handles and carry actual owner/lineage. Expose execution receipt/root observation diagnostics without turning unknown exit into success. Retry incomplete disposal through the same owner.
- [ ] Public caller-scope API carries only trusted immutable owner into nested calls. Service accepts a host policy resolver/validator and driver selector, not raw model-supplied authority. Defaults for standalone tests/CLI explicitly bind the configured workspace and unrestricted mode when sandbox was unset.
- [ ] Migrate all actual shell/scoped/subagent consumers to await changed APIs. TDD real pipe/stdin/stdout/stderr/spill/stream/promotion/cancel plus delayed descendant behavior through native driver. No direct spawn remains in exec service. Review before next task.

## Task 3: Terminal is a view adapter

**Files:** terminal service/tool/index/package dependencies/tests; desktop-gateway terminal/host cleanup consumer and affected tests.

- [ ] Terminal opens through the same exec supervisor, consumes PTY channel into existing bounded ring/cursor/raw-output view, and delegates input/resize/signal/close. Remove node-pty launch from terminal. Preserve ownership checks and the distinction between terminal root exit and native settlement.
- [ ] Make actual open/signal/close/resize/dispose consumers await admission/settlement. Restricted PTY uses supported backend only; no unconfined retry. Human terminals use explicit desktop-user owner, independently of model sandbox grants.
- [ ] Real ConPTY input/resize/interrupt/close and existing owner/window/rawOutput tests. Failed close retains record/owner and reports incomplete cleanup. Node-pty helper diagnostic workaround may remain only where its actual POSIX/legacy consumer still needs it. Independent review.

## Task 4: Explicit authority, actual child identity and acknowledgements

**Files:** session-executor execution-runtime composition module/assembly/service/scoped policy and tests; desktop-gateway project-scope/approval-policy-identity/host/agent-settings/router and focused tests; public shared options/dependencies as required. Keep platform details outside assembly.

- [ ] Broker produces versioned unbound/bound/revoked/unavailable authority and live references, with durable child inheritance. Compile every call under actual owner. No revoked catalog/missing getter fallback to old workspace in execution, FS or remembered approval roots.
- [ ] Mount one exec before shell/terminal, install trusted tools/execute owner cascade and owner/role revision validator. Cover child inherited tools, nested Code Mode and file search, with root/child receipts showing durable identities. Unknown/spoofed/unavailable caller refuses. Parent visibility/cancellation of child jobs follows trusted lineage.
- [ ] Async mode/catalog/root/references/role narrowing revalidates pending admission and drains incompatible active handles before response. Existing bound call grants stay tied to captured base generation; a widened policy cannot mutate a running handle. Add real delayed-writer gates for revoke and [A,B]→[A], plus deferred prepare and failed-disposal acknowledgement tests.
- [ ] Session/service/CLI/Desktop disposal awaits exec then driver composition. Remove raw winSandbox disposal workaround from assembly. CLI/TUI/SDK callers of mode updates await the new operation where a response acknowledges effectiveness. Independent review.

## Task 5: CLI/Desktop artifacts and complete gates

**Files:** scripts/build-dist.mjs and verification; desktop gateway copying/package scripts/build config and focused artifact tests; docs/audit final acceptance, package docs and product usage instructions as necessary.

- [ ] Copy the exact helper+manifest/provenance into both runtime artifacts; fixed location/digest/protocol/architecture checked before execution. No PATH search/runtime compilation/download. Declare every workspace dependency and native asset. Do not change application version or publish.
- [ ] Package-owned helper build can run at build time via installed toolchain; artifact tests fail clearly for missing/stale helper. Record matching source, lock, binary hashes and OS/compiler versions. Build Windows CLI and Desktop artifacts and smoke their actual packaged entry points (not just source imports).
- [ ] Whole-branch independent review then fresh affected tests/typechecks/root gate and reachable package graph. Run complete existing verification once after concrete integration fixes; broaden only for remaining risk. Record inherited skips/ConPTY diagnostics and platform limits honestly.
- [ ] Final real evidence: confined Bash/Node, reference read-only and unchanged metadata, workspace writes, explicit readonly denials, foreground→background without respawn, descendant retention/cancel, PTY, owner lineage, revocation acknowledgement and no owned process/lease left. Preview assurance remains explicit even when these observations pass.

## Completion

All required phases must have actual production consumers and packaged evidence. Contracts/fake drivers alone cannot satisfy the redesign. Retain local feature branch and commits; this phase has no new push/release request. Do not request a second generic permission to continue already approved implementation.
