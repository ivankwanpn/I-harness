# Hooks

`src/index.ts` is the stable public entry. It exports the existing hook types,
registry/configuration functions, runner functions and user-layer trust helpers.
`src/registry-types.ts` contains the contracts extracted from the original entry;
the pre-existing `src/types.ts` remains the hook wire/output/error type owner.

| Module | Responsibility and lifetime |
| --- | --- |
| `configuration/load.ts` | Config-home resolution, strict native/Claude loading, explicit missing-config failure and load-time grants/trust verdicts |
| `configuration/validation.ts` | Native declaration validation, copied command/trust fields and reserved Claude-metadata rejection |
| `configuration/matchers.ts` | Native exact/regex and Claude event/tool matching, per-call command dialect and format selection |
| `execution/handlers.ts` | Config-order gate/observer execution and per-handler report-once handling |
| `execution/permissions.ts` | Permission output folding into the host's ToolDecision vocabulary |
| `execution/runtime.ts` | Per-registry invocation, lazy fallback session, child WeakMap identity, owned transcript capture/release and live grant validation |
| `registry.ts` | Sole loaded-handler, report-set, trust-revision, active-approval and disposed owner; composition, refresh and disposal |
| `lifecycle/session.ts` | Sole active-session, startup-revision, result-cache and pending-promise owner; programmatic events and cached context |
| `lifecycle/mount.ts` | Runtime-stop registration and tool/permission/prompt/native-stop listener registration |

The registry creates one transcript projection and obtains the existing Claude
runtime service. Report/env option getters run before initial config loading;
active approvals are read after the awaited load and mount-name creation, so a
caller replacing the store during loading supplies the ongoing authority.
Stop registration precedes plugin mount. The mounted cascade
runs one pre/post pair per logical tool call and skips marked redispatch frames.
Permission listeners, prompt waterfalls, native stop and Claude runtime stop
retain their distinct control paths. A completed tool body keeps its result when
its post-hook owner is aborted; other vetoes propagate.

Execution and startup caching read live registry authority through explicit
operations/getters. Unapproved declarations remain inactive; changed approved
artifacts close gates. Refresh advances trust/startup revisions, changes approvals,
withdraws cached results and invalidates loaded handlers before reloading. Startup
results remain keyed by handler/content grant/session/source and are published
only after the original trust and stale-result checks. Disposal marks the registry,
removes runtime stop, advances/clears startup state, awaits plugin unmount, clears
loaded handlers and disposes the projection in that order. A failure stops that
sequence at the same operation as before; subsequent disposal sees the disposed mark.

`runner.ts`, `trust.ts`, `claude.ts`, `claude-runtime.ts` and
`claude-transcript.ts` retain independent ownership of subprocess/output policy,
artifact grants, Claude adaptation, runtime feedback and transcript projection.

Tests: `hooks.test.ts`, `policy-refusal.test.ts` and `site-diagnostics.test.ts`
cover native config/trust/gates/reporting; `claude-plugin.test.ts` and
`refresh-trust.test.ts` cover startup grants, caching and races;
`claude-events.test.ts`, `claude-protocol.test.ts`, `owned-process.test.ts` and
`hooks.test.ts` cover runtime payloads/transcripts, child identities,
cancellation and pre/post order; `command-binding.test.ts`, `hook-trust.test.ts`
and `plugin-tree-authority.test.ts` cover exact command/artifact authority.
`registry-initialization.test.ts` covers option getter order, explicit missing
config precedence and approval-store replacement during a held config read.
`registry-lifetime.test.ts` characterizes mount
and disposal order, including stop-remover/unmount failures, on original and split
sources. Run `pnpm --filter @i-harness/hooks exec vitest run --maxWorkers=2 --minWorkers=1`
then `pnpm --filter @i-harness/hooks typecheck`; run native suites sequentially.
