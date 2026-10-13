# IH v0.1.13 product-code decomposition research

Read-only research at `460a2aee9395dafe196eb31425dcc2c3fcdc259e`. Only census scripts/data and this report were created under `.tmp/v0113-research`. No product code, tests, profiles, providers, branches or native build artifacts were changed; no tests/builds were run. The latest user instruction limits active decomposition to maintained product code, independently of whether the file contains event polling. **Tests and tool scripts are OUT OF SCOPE for decomposition.** They remain measured inventory only; existing tests may be run for verification and receive necessary import/path adaptations, with no test-suite or audit-tool restructuring.

## Measurement and scope

The census reads `git ls-files`, covering **2,378 tracked files**. Extensions considered code: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.rs`, `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hpp`, `.py`, `.ps1`, `.psm1`, `.sh`, `.cs`. Path classification separates production/configuration code, tests/e2e, scripts, docs, fixtures/test data, generated/release/build outputs, and vendor material. No generated or vendor source content was read for refactoring.

| Category | Code files | Physical lines read | Files >=800 lines |
|---|---:|---:|---:|
| Production/configuration | 630 | 98,466 | 15 |
| Tests/e2e | 844 | 124,834 | 15 |
| Scripts | 61 | 11,000 | 1 |
| Fixture/test data, excluded from maintained-code targets | 9 | 1,135 | 0 |
| Vendor code, content not read | 10 | Not measured | Not asserted |
| Generated-category tracked artifacts | 0 code files | Not measured | Not asserted |

The full measured maintained-code total is **1,535 files / 234,300 physical lines**. There are **31 measured maintained files >=800 lines**, but only **15 product files >=800 lines** are in the active decomposition scope; the 15 test files and one tool script are measurement-only exclusions. The TypeScript AST pass finds **46 production function/component spans >=250 lines** in 38 distinct production files, plus **48 test function/container spans**. Nested function spans overlap; these are not 94 independent refactoring tasks. Test `describe` callbacks often measure a whole suite rather than one huge test body.

File size and function size are separate signals. The union of large production files and long production functions is **42 production files**. A second density check catches one additional maintained production component: `SessionManager.tsx`, 185 lines / 20,560 function characters. Thus the active scope is **43 product candidate files in 32 subsystem groups**, including 28 below the 800-line threshold. A Rust function was manually confirmed as another long function: `runner.rs:687-993`, `run`, 307 lines. Rust was not passed through a fake TS parser for function claims.

Line counts include comments and blank lines; nonempty counts retain comments. `census.json` also includes a best-effort JS/TS lexical comment-excluded nonempty count, maximum line length and lines over 240 characters. The comment-excluded metric is advisory because scanner context for templates/regular expressions/JSX can differ; use physical/AST spans as the reproducible thresholds. The density screen is `<250 lines && >=18,000 function characters`, not a claim that all conceptual complexity is measured. Native `runner.rs` is mixed: lines 1-994 contain production code, lines 995-1246 an embedded `#[cfg(test)]` module; file-level classification still correctly flags the entire maintained source file.

Machine-readable detail is in `census.json`, with all measured code files, all threshold hits, all long function spans, compressed candidates, declaration boundaries, static import consumers and package test inventories. Static consumer resolution includes relative imports and `.js`-to-TS source mapping plus package-index facades; dynamic imports and indirect package reexports require follow-up. A missing direct consumer entry is not dead-code evidence.

## Refactoring rules for every first slice

1. **First slices are behavior-preserving moves**: extract existing types/constants/pure helpers, then cohesive capability modules with explicit dependencies. Preserve current public entrypoints/exports as a single facade. Do not simultaneously change event semantics, default values, request/error schemas, task ordering, cancellation, persistence format, retry cadence or UI state identity.
2. **One owner remains responsible for each lifetime**: assembly, session service, execution supervisor, native process, transport generation and renderer scope keep their existing ownership until a separately reviewed behavioral change. Extraction must not copy mutable maps into parallel owners, create a second settings store, or add listener registration in multiple places.
3. **Avoid disguised monoliths**: no generic `helpers.ts` dump or full-state `context:any` passed to every module. Each module gets the narrow data/actions it actually uses. Keep disposal and mutation ordering explicit. Facades orchestrate modules; they do not import implementation internals through a cycle.
4. **Tests and tool scripts are not decomposition targets**: preserve existing test files, suite organization, assertions, setup/teardown and fixture ownership. Use existing tests for verification and make only necessary import/path adaptations after product module moves. Do not split large suites, extract test harnesses or restructure audit scripts under this plan.
5. **Use existing tests as first gates**: baseline the affected suites before each extraction and run the same suites plus package typecheck after it. If a product module move requires an import/path adaptation in an existing verification file, keep that adaptation minimal. Do not weaken assertions, rewrite audit baselines or restructure tooling to get green results.
6. **Size budgets are review triggers**: proposed default <=400 product lines/file and <=120 function/component lines, allowing cohesive type/protocol declarations or documented exceptional algorithms. Do not pad/move comments or compress lines to satisfy a numeric metric. A facade should normally remain <=150-250 lines. The user requested decomposition broadly, so each of the 43 files must receive an explicit split or documented evidence-based exception.

## Concrete production subsystem map

Paths below are proposed relative to each current package `src/` unless a complete path is shown. Existing entrypoint names remain facades, preserving all consumers. The appendix gives exact current file/function bounds and direct-import examples; the JSON retains the complete static consumer inventory.

| Group / current candidates | Proposed cohesive modules and sole public facade | Current consumer and first verification gate |
|---|---|---|
| **Settings** — `packages/settings/src/index.ts` | `schema/types.ts`, `schema/defaults.ts`, `normalize/{primitives,providers,execution,tui}.ts`, `storage/{single-store,layered-store,json-patch,revision}.ts`, `observation/watch-settings.ts`; `index.ts` reexports. First move pure normalizers and document patching, then storage, watcher last. Existing `context-subsystems.ts`/`sections.ts` stay domain modules. | Consumers include session assembly, provider-runtime/provider, persistence, gateway settings controllers. Gate existing `settings/test/{settings,layering,watch-events,watch,sections}.test.ts`, provider-runtime file-runtime tests and settings typecheck; preserve defaults/legacy migration and comment-preserving patch behavior. |
| **Session model and projection** — `core-session/src/index.ts` | `events/{types,append,subscription}.ts`, `projection/{messages,search,rewind,pruning,plan,title}.ts`, `serialization/jsonl.ts`, `images.ts`; `index.ts` facade. Extract pure projections before append/subscribe ownership. | Assembly/service, SDK server, core-agent/subagent, persistence. Gate `core-session/test/{session,rewind-event,prune-event,projection-rewrite}.test.ts`; compare exact event seq and projected messages across rewinds/prunes. |
| **Provider catalogue/runtime** — `provider/src/index.ts`, `provider-runtime/src/index.ts` | Provider: `catalog/{load,resolve,context}.ts`, `probe/{http,normalization,registry}.ts`, `clients/{build,validation}.ts`, `web-search/registry.ts`. Runtime: `directory/{view,merge}.ts`, `selection/{binding,resolve}.ts`, `configuration/{validation,mutation}.ts`, `runtime/create-runtime.ts`. Each package keeps its own `index.ts` facade; do not combine registry and per-session runtime ownership. | `apps/cli/src/{index,run,models,provider}.ts`, gateway host/provider/coding-plans, compaction. Gate provider `directory/provider/retry-wiring/prompt-cache` and runtime `runtime/file-runtime/chatgpt-plan` tests; catalogue precedence and exact error states unchanged. |
| **Provider adapters** — `llm-{openai,anthropic,gemini,bedrock,openai-compatible}/src/index.ts` | Each package independently gets `request/{messages,reasoning,headers}.ts`, `stream/{decode,fold,usage}.ts`, `client.ts`; `index.ts` facade. Preserve per-provider protocol differences; no new cross-provider normalization framework in first pass. Extract serialization/usage mapping first, stream reader cleanup last. | `packages/provider/src/index.ts` imports all adapters. Gate each package's named main test file, its retry/stream-activity/recovery tests where present; OpenAI affinity/function-arguments/Codex tests, Anthropic image recovery, Bedrock stream recovery. Preserve raw continuation blocks, usage, cache and abort/retry behavior. |
| **MCP connection supervisor** — `mcp-client/src/supervisor.ts` (528 lines; `createMcpSupervisor`, lines 92-528, 437 lines) | `supervisor/{types,status,generation,catalogue,recovery,disposal}.ts`; keep `supervisor.ts` as the internal create-factory facade and existing package `index.ts` as the sole public facade. Extract status formatting and catalogue/readiness helpers first; generation ownership, retry/stability scheduling and disposal last. Keep one owner for current connection generation, pending refresh, retry timers and cancellation. Existing OAuth/token owners remain authoritative; the supervisor only consumes their lifecycle results. | Exact static consumers: `packages/mcp-client/src/scheduler.ts` and `packages/mcp-client/src/index.ts`. Gate existing `packages/mcp-client/test/{reconnect,lifecycle,sync,oauth-integration,oauth}.test.ts` plus package typecheck; preserve tool-list refresh/readiness barriers, reconnect backoff, auth failure reporting, late callbacks from retired generations and complete timer/listener disposal. Existing tests stay organized as they are; only necessary import/path adaptations. |
| **Plugin execution scope** — `core-plugin/src/index.ts` | `scope/{services,listeners,waterfall,cascade,dispose}.ts`, `types.ts`; `index.ts` facade calls one scope owner. Keep listener ownership/order and redispatch token identity unchanged. | Assembly, tools, shell, providers/hooks. Gate `core-plugin/test/{plugin,cascade,site-diagnostics}.test.ts`; verify no listeners survive owner disposal and return values keep waterfall semantics. |
| **Tool registry** — `core-tools/src/index.ts` | `registry/{catalog,prepare,dispatch,finalize}.ts`, `approval/{identity,arguments,decision}.ts`, `types.ts`; `index.ts` facade. Keep prepared-call authority in a single closure/state owner. | Assembly, subagent tools, core-agent, shell. Gate `core-tools/test/{tools,dispatch-authority,dispatch-command-metadata,guardian-seam,observation}.test.ts`; preserve role/plan/approval authority and exactly-once finalization. |
| **Hook registry** — `hooks/src/index.ts` | `configuration/{load,validation,matchers}.ts`, `execution/{handlers,permissions}.ts`, `registry.ts`; `index.ts` facade. Reuse existing runner/trust modules rather than duplicate them. | CLI run/hooks, gateway host/resources/plugin-mount. Gate `hooks/test/{hooks,claude-plugin,claude-protocol,command-binding,hook-trust}.test.ts`; preserve plugin root trust and hook output parsing. |
| **Shell tools/discovery** — `shell/src/index.ts` | `discovery/{windows,posix,environment}.ts`, `command/{resolve,argv}.ts`, `tools/{foreground,background,retention,registration}.ts`; `index.ts` facade. Pure discovery/argv moves before admitted-execution behavior. | Assembly, CLI headless, workflow runner, gateway agent-shell/terminal-shells. Gate `shell/test/{shell,windows-discovery,agent-shell,sandbox-per-call,sandbox-refusal,spill-notice,remembered-identity}.test.ts`. |
| **Execution service/supervisor — S13 implemented** — `exec/src/service.ts`, `exec/src/execution-supervisor.ts` | Factories now 11/8 physical lines. Service modules: `capture/{contracts,input,output,retention,completion}.ts`, `jobs/{contracts,records,views,observation}.ts`, `execution-host.ts`, `transport-launch.ts`. Supervisor modules: `supervision/{contracts,admission,ownership,retirement,reconciliation}.ts`. Existing `index.ts` remains sole public facade; one job owner, one capture lifetime and one supervisor registry. Actual sizes and factory exceptions are recorded below. | Exec 247/247 in 16 files, types exit 0; Shell requested consumer/native gates 39/39 in 3 files, types exit 0; session-executor scoped/steering 19/19 in 2 files, types exit 0. Audit: identical actual 419-row set/digest, 73/73 self-tests and gate exit 0; separate original service/supervisor audit owners. Full evidence: `.superpowers/sdd/2026-10-13-v0.1.13-product-decomposition/task-S13-report.md`. |
| **Native PSEC runner** — `sandbox-windows-psec/native/src/runner.rs` | Keep `runner.rs` as the public `run/fatal` facade with its existing embedded tests in place; extract private product modules `runner/{prepared,running,control,status,event_drain,dispatch}.rs`. Move product status/control serialization first, prepared owner next; state machine/unsafe handle ownership last. Do not extract or restructure the embedded test module; only adapt imports if necessary. S14 actual split has a 68-product-line facade (34-line `run`) and private modules of 243/439/60/38/55/295 lines. The 439-line `running.rs` is a controller-approved cohesive exception to the proposed 400-line guide: it keeps one original field/drop order and one native handle/tree/I/O/termination authority, including last-resort `Drop`; every operation is at most 119 lines. Prepare/commit methods keep dispatch's handler at 115 lines. Splitting that owner to meet a numeric target would obscure cleanup authority. | `native/src/main.rs` calls `runner::run/fatal`; external protocol consumed by TS native session. Gates `test:native`/`smoke:native`, TS `fake-session`/`real-driver` and qualification tests under existing platform prerequisites. Preserve protocol frames, OS handle RAII, denied-process cleanup and retained-tree behavior. The measured baseline was 994 product lines and a 307-line `run`; its 252 embedded test lines remain intact and excluded. Native source relocation requires recursive PS5-compatible source provenance and fresh actual helper/qualification evidence. S14 preserves polling and the observed incomplete/experimental qualification boundary; E8 event migration and final product qualification remain separate gates. |
| **Code Mode runtime** — `code-mode/src/runtime.ts` | `runtime/{limits,cell-state,output,worker-events,admission,retirement}.ts`; `runtime.ts` factory facade, package `index.ts` public entrypoint. Keep one cell registry and worker lifetime owner. | `code-mode/src/{register,index}.ts`. Gate `code-mode/test/{runtime,store,register,text-retention,cpu-budget,human-stop,image-admission}.test.ts`. |
| **Code Retrieval** — `code-retrieval/src/service.ts` | `service/{configuration,index-job,search,revalidation,status}.ts`; `service.ts` factory facade. Existing store/embedding/reader modules remain owners. First extract search filters/results and status formatting, then job staging; avoid splitting commit/cancel into races. | `code-retrieval/src/index.ts`, gateway context runtime. Gate `code-retrieval/test/{service,review,embedding,store-plan}.test.ts`; preserve transactional index generation, source authority and cancellation. |
| **Compaction** — `compaction/src/index.ts` | `engine/{admission,prune,summary,commit}.ts`, `projection/{shadowed,window}.ts`; `index.ts` facade. Keep compaction as one transaction that owns projection mutation. | Assembly, core-agent, CLI run. Gate `compaction/test/{engine,prune,slices,summarizer,summarizer-prefix}.test.ts`; context/prefix/rewrite invariants, not merely output shape. |
| **Persistence coordinator** — `session-persistence/src/index.ts` | `coordinator/{types,load,ownership,documents,mutations,lifecycle}.ts`, `format/{registry,validation}.ts`; `index.ts` facade. Preserve write-behind/lock owner and public coordinator behavior. | Session assembly/service, SDK, CLI. Gate `session-persistence/test/{persistence,ownership,repair,fork,write-behind}.test.ts`; additionally service close-retry coverage. |
| **Session query index** — `session-query/src/file-backed.ts` | `file-backed/{database,schema,inspection,index-refresh,query}.ts`; `file-backed.ts` facade and existing package index exports. Preserve single connection ownership and locked inspection semantics. | `session-query/src/index.ts` exports query implementation. Gate `session-query/test/{filebacked,query,warning,tools}.test.ts`; corruption/foreign index warnings and output ordering unchanged. |
| **Subagent tools/child creation** — `subagent/src/tools.ts`, `subagent/src/child.ts` | `tools/{spawn,followup,wait,cancel,status,team}.ts`, `child/{prompt,role-tools,model-binding,assembly,lifecycle}.ts`, `followup/{resident,drive,inbox}.ts`; package `index.ts` sole public facade, factory facades in existing files. Preserve durable parent-child identities and one admission/cancellation owner. | `subagent/src/index.ts`, tools, projection, session executor. Gate `subagent/test/{child,tools,resume,persist,projection}.test.ts` plus session-executor child-observation, code-mode-children and role-model wiring. |
| **Team scheduling** — `agent-team/src/scheduler.ts` | `scheduler/{admission,teammate-lifecycle,task-delivery,completion,recovery}.ts`; `scheduler.ts` mount facade, package index unchanged. Extract status/role helpers first and retain the same roster/board ownership. | `agent-team/src/index.ts`. Gate `agent-team/test/{lifecycle,completion-delivery,roster,mailbox,task-board}.test.ts`; preserve message/durable-completion ordering. |
| **Session assembly/service** — `session-executor/src/{assembly,service}.ts` | Assembly: `assembly/{types,context,models,tools,plugins,hooks,subagents,execution,cleanup}.ts`. Service: `service/{types,assembly-cache,input-admission,turn-queue,execution-state,session-controls,shutdown}.ts`. `index.ts` public facade; existing create factories remain narrow internal facades. Start with contracts/pure formatting then capability mount functions; centralize disposal registration once. Service queue and admission state move only after focused tests preserve ordering. | Service imports assembly; `session-executor/src/index.ts` exposes factories to CLI/SDK/gateway. Gates `assembly/service/assembly-import/execution-state/event-driven-steering/admitted-input/native-context-lifecycle/project-context/scoped-exec` tests plus existing sandbox per-call tests. This is not a reason to share all mutable factory locals through a giant context object. |
| **Core agent/tool batch — S17 implemented, fresh review pending** — `core-agent/src/{index,execute-tool-calls}.ts` | Facades 863 → 21 / 584 → 4; `createAgent` 658 → 30, `executeTurn` 478 → 81, batch controller 506 → 63. Actual owners: `agent/{types,create,registry,context,turn,step-input,model-loop,model-step,reasoning,finalization}.ts` and `tool-batch/{types,prepare,dispatch,join,record,cancel}.ts`. Keep cross-followup state, synchronous step folds, original awaits and one finalization authority; existing executor remains independent. | Core-agent 199 pass + 1 existing model-policy skip / 25 files; prescribed subagent 123 / 3 and session-executor 56 / 3; all three types exit 0. Two original/split characterizations, 70 AST/API/state/audit checks; exact separate original source-owner mappings restore the identical actual 419 finding objects/order/digest. Full evidence: `task-S17-report.md` in the SDD evidence directory. |
| **SDK server** — `sdk/src/server.ts` | `server/{state,initialize,session-reads,session-controls,prompt,rewind,models,shutdown}.ts`, `validation.ts`; `server.ts` factory facade and package index unchanged. Route handlers get narrow authorized services; parse/framing and public errors stay central. | Package SDK entrypoint (and dynamic import consumers such as CLI/gateway); server direct consumer scan alone is not exhaustive. Gates `sdk/test/{server,protocol,bounded-writer,e2e}.test.ts` and CLI sdk-wire-v11. Preserve initialized state, inflight correlation, capabilities and notification ordering. |
| **CLI dispatch/headless** — `apps/cli/src/{index,run}.ts` | `commands/{dispatch,run,sdk,acp,selfcheck}.ts`, `headless/{options,environment,assembly,output,cleanup}.ts`; `index.ts` remains executable entrypoint and `run.ts` retains exported headless API. Keep existing per-command modules (`models/provider/hooks/sessions`) instead of duplicating them. | CLI bin launches index; index imports run. Gates CLI `cli/run-flag-routing/run-protocol-selection/run-end/graceful-shutdown/cleanup-retry/sdk-wire-v11/bare-launch/bin` tests. Preserve exit codes/stdout-vs-stderr/config precedence and cleanup retries. |
| **Desktop gateway composition/routing** — `desktop-gateway/src/{host,router}.ts` | `host/{configuration,domains,execution,subscriptions,shutdown}.ts`, `router/{initialize,session,settings,resources,projects,terminal,validation}.ts`; host/router factories remain public facades through gateway index. Existing domain controllers remain authoritative; the router must not grow another copy of them. | `cli.ts -> host.ts -> router.ts`. Gates gateway `host/router/lifecycle/host-close-retry/execution-surfaces/project-scope-host` tests plus relevant domain router tests. Preserve request vocabulary and `createGatewayWrite` filtering. |
| **Project scope broker** — `desktop-gateway/src/project-scope.ts` | `project-scope/{bindings,validation,lease,rebind,retirement}.ts`; `project-scope.ts` factory facade. Native-confirmed membership remains authority; avoid a mutable renderer-facing duplicate map. | Gateway host/types. Gate gateway `project-scope/project-scope-host` and session-executor `project-context/revoked-prompt-cleanup/rebind-budget` tests. |
| **Desktop subagent catalogue** — `desktop-gateway/src/session-subagents.ts` | `session-subagents/{projection,visibility,bindings,controls,observation}.ts`; current file factory facade. | Gateway host/types. Gate gateway `session-subagents/desktop-child-authority-host` and desktop `subagent-pane` tests. Preserve child visibility and durable/live ownership distinction. |
| **Coding Plans account owner** — `coding-plans/src/codex-management.ts` | `management/{document,identity,token,device-login,usage,redemption,lifecycle}.ts`; current create factory facade via index. Maintain one account lock/admission identity; serialization does not expose credentials. | Package index and gateway coding-plans. Gate `coding-plans/test/codex-management.test.ts` and desktop coding-plans bridge/UI tests. Extract validation/public redaction before auth transaction changes; no provider/account changes during research. |
| **Desktop main IPC** — `desktop/src/main/ipc.ts` | `ipc/{registration,validation,native-requests,workspace-requests,project-requests,session-requests,resource-requests}.ts`; `ipc.ts` sole facade. Keep native sender/window validation before handler dispatch; same request surface and dependencies. | Main index, project-content-search/project-files/project-membership type imports. Gate desktop `ipc/context-picker-ipc/resource-suggestions-ipc/runtime-diagnostics-ipc` tests and project file/review scope tests. |
| **Desktop runtime diagnostics** — `desktop/src/main/runtime-diagnostics.ts` | `runtime-diagnostics/{classification,redaction,buffer,projection,subscriptions}.ts`; current factory facade. | Main index/IPC. Gate desktop `runtime-diagnostics/runtime-diagnostics-ipc/runtime-capacity-diagnostics/diagnostics-feedback` tests; preserve redaction, bounds and scope filtering. |
| **Desktop App composition** — `desktop/src/renderer/app.tsx` | `app/{use-runtime-connection,use-session-selection,use-session-events,use-project-navigation,AppLayout}.tsx` and explicit shared view types; `app.tsx` exports `App`. Move leaf layouts/pure selections first; keep one active session/epoch owner. | `renderer/main.tsx`. Gate desktop `app-selection/central-ui-integration/backend-integration/context-usage` tests; no changing component keys/draft lifetime while extracting. |
| **Workbench** — `desktop/src/renderer/shell/Workbench.tsx` | `workbench/{ConversationView,ReviewView,PaneHost,use-pane-navigation,use-workflow-view}.tsx`; current file facade. | `app.tsx`. Gate `workbench/workbench-hidden-readers/workbench-context-refresh/project-review-workbench/todo-progress-workbench` tests; preserve retained/hidden panes and visible-only reads. |
| **Composer** — `desktop/src/renderer/session/Composer.tsx` | `composer/{draft-storage,use-send,use-attachments,use-context,ComposerToolbar,SessionComposer,NewTaskComposer}.ts(x)`; `Composer.tsx` retains current exports (`Composer`, draft APIs etc.). Existing durable-draft-client/pickers remain their own modules. | App, Workbench, permission preview. Gate desktop composer durable-drafts/attachments/pickers/runtime-errors/approval-menu tests; preserve optimistic retirement, pending send identity, focus and attachment scope. |
| **Session manager dense component** — `desktop/src/renderer/session/SessionManager.tsx` | `session-manager/{types,use-catalogue,use-selection,use-batch-actions,SessionRow,SessionActions}.tsx`; current file exports `SessionManager`. Split state/action ownership by concern before JSX; avoid formatting-only “fix”. | Workbench. Gate `desktop/test/session-manager.test.tsx`, session-management gateway tests; preserve batched action atomicity, confirmation and scope. |

## Tests and tool scripts: measurement only, out of scope

The full census retains the 15 oversized test files, 48 long test AST spans, three dense test-container candidates and the 2,099-line `scripts/audit/check-reachability.mjs` for factual completeness. **None is an active decomposition task.** Do not split test suites, move embedded native tests, extract test helpers or restructure audit/tool scripts. Existing tests remain verification gates; necessary import/path adaptations caused by product module moves are permitted without changing test organization or coverage. The existing audit tool may be consulted as a gate, but its size does not authorize a refactor or baseline rewrite.

## Dependency order and concrete completion gates

**Phase A — establish inventory/contracts and stable facades.** Save census as a baseline, record exported symbol and package export paths, inspect source-text audit gates. Keep tests and tool scripts structurally unchanged; extract product types/normalizers/projections from settings, core-session, provider, shell and adapter request conversion. Baseline targeted tests before moving code. No event behavior changes in this phase.

**Phase B — leaf service decomposition.** Core-plugin/core-tools/hooks, MCP supervisor, provider-runtime, persistence/query, compaction, model adapters. Each extraction gets a narrow factory dependency type, unchanged public facade and package typecheck plus listed tests. Verify no new import cycles and import-time side effects. Do not start the broad assembly rewrite before its dependencies have stable facades.

**Phase C — execution/agent owners.** Exec service/supervisor, native runner, code-mode/retrieval, core-agent batch/turn, subagent child/tools, team scheduler. Split pure views first; lifecycle modules last with explicit single-owner state. Native testing requires its proper platform/driver prerequisites and cannot be represented by TypeScript mocks alone. Run existing authority/cancel/drain/retained-resource tests for every relevant extraction.

**Phase D — host composition and transport.** Session assembly/service, SDK, CLI, gateway host/router/project-scope/subagent catalogue, coding-plans, Electron IPC/diagnostics. Facades must remain usable by the current package, desktop packaged runtime and CLI entrypoints. Verify wire/capability/error compatibility, same shutdown and resource ownership, unchanged provider/settings writes. Package artifact verification is relevant once module layout/export paths move; do not assume source tests prove bundled deployment correctness.

**Phase E — renderer decomposition.** App, Workbench, Composer and SessionManager product modules, starting with stateless leaf renderers. Existing test files remain verification gates, with necessary import/path adaptations only. Preserve component keys, retained hidden forms, pending mutation locks, generation/epoch fences, effect dependencies and cleanup. Run current component/IPC integration tests, then functional walkthroughs of navigation, drafts, terminal/browser and execution panes when implementation is authorized.

**Phase F — event conversion on the new seams.** Only after each owner's behavior-preserving extraction passes its gate, add the revisioned snapshot/watch changes from the event research as separate reviewable changes. This is where semantic event delivery tests belong. Do not combine “moved 1,000 lines” and “changed cancellation/ownership/event semantics” in an indistinguishable diff.

Completion for decomposition requires: every one of the 43 product candidates has moved into cohesive modules or a recorded justified exception; no public exports/wire/persistence behavior changes in extraction slices; existing tests retain their organization, equivalent coverage and fixture isolation; no test/tool-script decomposition is included; targeted tests/typecheck pass; packaged/native gates run where relevant; census rerun records reduced file/function spans without line compression; no new module exceeds the budget by merely collecting the extracted code. This research establishes the map, not proof that any refactor already passes.

## Generated census appendices

The following tables are generated from the saved tracked-file census; identifiers and bounds refer to the researched HEAD.

### Full measured inventory >=800 lines — only product rows are in scope

| File | Category | Physical | Nonempty | Nonempty after advisory comment masking |
|---|---|---:|---:|---:|
| `apps/cli/test/cli.test.ts` | tests | 2288 | 2190 | 1482 |
| `scripts/audit/check-reachability.mjs` | scripts | 2099 | 1964 | 1697 |
| `packages/session-executor/test/assembly.test.ts` | tests | 1835 | 1752 | 1500 |
| `packages/subagent/test/child.test.ts` | tests | 1763 | 1655 | 1455 |
| `packages/session-executor/src/assembly.ts` | production | 1745 | 1711 | 1380 |
| `packages/provider-runtime/test/runtime.test.ts` | tests | 1735 | 1594 | 1476 |
| `packages/settings/src/index.ts` | production | 1698 | 1582 | 1171 |
| `packages/sdk/test/server.test.ts` | tests | 1655 | 1561 | 1502 |
| `packages/subagent/test/tools.test.ts` | tests | 1367 | 1289 | 1286 |
| `packages/core-agent/test/execute-tool-calls.test.ts` | tests | 1251 | 1197 | 948 |
| `packages/sandbox-windows-psec/native/src/runner.rs` | production (includes 252 test lines) | 1246 | 1242 | Not measured |
| `packages/session-executor/test/service.test.ts` | tests | 1222 | 1154 | 1098 |
| `packages/provider-runtime/src/index.ts` | production | 1173 | 1105 | 1033 |
| `packages/session-executor/src/service.ts` | production | 1132 | 1101 | 964 |
| `packages/provider/src/index.ts` | production | 1044 | 974 | 869 |
| `apps/cli/src/run.ts` | production | 1019 | 1001 | 788 |
| `packages/mcp-client/test/oauth-real-as.test.ts` | tests | 1019 | 977 | 904 |
| `packages/sdk/src/server.ts` | production | 1015 | 986 | 800 |
| `apps/cli/src/index.ts` | production | 995 | 967 | 934 |
| `packages/core-session/src/index.ts` | production | 984 | 932 | 788 |
| `packages/llm-anthropic/test/anthropic.test.ts` | tests | 983 | 921 | 921 |
| `packages/subagent/src/tools.ts` | production | 916 | 894 | 859 |
| `packages/core-agent/test/agent.test.ts` | tests | 914 | 866 | 845 |
| `packages/llm-gemini/test/gemini.test.ts` | tests | 909 | 849 | 843 |
| `packages/plugin-registry/test/registry.test.ts` | tests | 871 | 799 | 798 |
| `packages/llm-openai/test/openai.test.ts` | tests | 869 | 811 | 793 |
| `packages/core-agent/src/index.ts` | production | 863 | 832 | 747 |
| `packages/shell/src/index.ts` | production | 836 | 812 | 779 |
| `packages/provider/test/directory.test.ts` | tests | 833 | 776 | 760 |
| `packages/desktop/src/renderer/app.tsx` | production | 807 | 784 | 771 |
| `packages/desktop/src/main/ipc.ts` | production | 800 | 787 | 777 |

### All 43 production candidate files and measured long functions

The complete static consumer set is stored per file in `census.json`; this table shows up to three distinct production consumers as exact paths. An empty static match requires package/dynamic/native entrypoint tracing, not deletion. All 46 TS function spans, including nested spans, are listed here.

| Current file | Lines | Function/component >=250 lines, or density candidate | Direct production consumers (examples) |
|---|---:|---|---|
| `packages/session-executor/src/assembly.ts` | 1745 | `createSessionAssembly` 496-1745 (1250 lines) | `packages/session-executor/src/service.ts`; `packages/session-executor/src/index.ts` |
| `packages/settings/src/index.ts` | 1698 | File threshold; no qualifying TS function | `packages/session-executor/src/assembly.ts`; `packages/provider-runtime/src/index.ts`; `packages/provider/src/index.ts` |
| `packages/sandbox-windows-psec/native/src/runner.rs` | 1246 | `run` 687-993 (307 lines) | Facade/native/dynamic entrypoint; see subsystem map |
| `packages/provider-runtime/src/index.ts` | 1173 | `createProviderRuntime` 253-866 (614 lines) | `apps/cli/src/run.ts`; `apps/cli/src/index.ts`; `apps/cli/src/models.ts` |
| `packages/session-executor/src/service.ts` | 1132 | `createSessionService` 255-1132 (878 lines) | `packages/session-executor/src/index.ts` |
| `packages/provider/src/index.ts` | 1044 | File threshold; no qualifying TS function | `packages/provider-runtime/src/index.ts`; `apps/cli/src/index.ts`; `packages/compaction/src/index.ts` |
| `apps/cli/src/run.ts` | 1019 | `runHeadless` 353-1019 (667 lines) | `apps/cli/src/index.ts` |
| `packages/sdk/src/server.ts` | 1015 | `createSdkServer` 199-889 (691 lines); `handleRequest` 377-856 (480 lines) | Facade/native/dynamic entrypoint; see subsystem map |
| `apps/cli/src/index.ts` | 995 | `main` 117-555 (439 lines); `runSdkCommand` 640-891 (252 lines) | Facade/native/dynamic entrypoint; see subsystem map |
| `packages/core-session/src/index.ts` | 984 | File threshold; no qualifying TS function | `packages/session-executor/src/assembly.ts`; `packages/session-executor/src/service.ts`; `apps/cli/src/run.ts` |
| `packages/subagent/src/tools.ts` | 916 | `createSubagentTools` 73-629 (557 lines) | `packages/subagent/src/index.ts` |
| `packages/core-agent/src/index.ts` | 863 | `createAgent` 185-842 (658 lines); `executeTurn` 346-823 (478 lines) | `packages/session-executor/src/assembly.ts`; `packages/session-executor/src/service.ts`; `apps/cli/src/run.ts` |
| `packages/shell/src/index.ts` | 836 | `createShellTools` 498-783 (286 lines) | `packages/session-executor/src/assembly.ts`; `apps/cli/src/run.ts`; `packages/workflow/src/runner.ts` |
| `packages/desktop/src/renderer/app.tsx` | 807 | `App` 51-807 (757 lines) | `packages/desktop/src/renderer/main.tsx` |
| `packages/desktop/src/main/ipc.ts` | 800 | `dispatchDesktopRequest` 63-688 (626 lines) | `packages/desktop/src/main/project-content-search.ts`; `packages/desktop/src/main/index.ts`; `packages/desktop/src/main/project-files.ts` |
| `packages/desktop-gateway/src/router.ts` | 716 | `createDesktopRouter` 96-710 (615 lines); `handleLine` 109-692 (584 lines) | `packages/desktop-gateway/src/host.ts` |
| `packages/hooks/src/index.ts` | 713 | `createHookRegistry` 437-713 (277 lines) | `apps/cli/src/run.ts`; `packages/desktop-gateway/src/host.ts`; `apps/cli/src/hooks.ts` |
| `packages/session-persistence/src/index.ts` | 702 | `createSessionCoordinator` 298-702 (405 lines) | `packages/session-executor/src/assembly.ts`; `packages/session-executor/src/service.ts`; `apps/cli/src/run.ts` |
| `packages/compaction/src/index.ts` | 681 | `createCompactionEngine` 66-407 (342 lines) | `packages/session-executor/src/assembly.ts`; `apps/cli/src/run.ts`; `packages/core-agent/src/index.ts` |
| `packages/agent-team/src/scheduler.ts` | 660 | `mountAgentTeams` 125-611 (487 lines) | `packages/agent-team/src/index.ts` |
| `packages/core-tools/src/index.ts` | 632 | `createToolRegistry` 288-632 (345 lines) | `packages/session-executor/src/assembly.ts`; `packages/subagent/src/tools.ts`; `packages/core-agent/src/index.ts` |
| `packages/desktop/src/renderer/session/Composer.tsx` | 604 | `SessionComposer` 260-604 (345 lines) | `packages/desktop/src/renderer/app.tsx`; `packages/desktop/src/renderer/shell/Workbench.tsx`; `packages/desktop/src/renderer/permission-preview.tsx` |
| `packages/subagent/src/child.ts` | 601 | `spawnChild` 274-601 (328 lines) | `packages/subagent/src/tools.ts`; `packages/subagent/src/index.ts`; `packages/subagent/src/projection.ts` |
| `packages/exec/src/service.ts` | 588 → 11 (S13) | Original `createExecService` 109-588 (480 lines); now 7-11 (5 lines). Cohesive capture/job/host modules 8-174 lines; see S13 inventory below. Gates: 247 Exec / 39 Shell / 19 session-executor tests, all package types exit 0; actual audit unchanged. | `packages/exec/src/index.ts` |
| `packages/core-agent/src/execute-tool-calls.ts` | 584 | `executeToolCalls` 79-584 (506 lines) | `packages/core-agent/src/index.ts` |
| `packages/session-query/src/file-backed.ts` | 558 | `createFileBackedSessionQuery` 236-558 (323 lines) | `packages/session-query/src/index.ts` |
| `packages/desktop/src/renderer/shell/Workbench.tsx` | 547 | `Workbench` 138-547 (410 lines) | `packages/desktop/src/renderer/app.tsx` |
| `packages/desktop-gateway/src/host.ts` | 539 | `createDesktopHost` 124-539 (416 lines) | `packages/desktop-gateway/src/cli.ts` |
| `packages/llm-gemini/src/index.ts` | 531 | `createGeminiClient` 172-513 (342 lines); `stream` 175-511 (337 lines) | `packages/provider/src/index.ts` |
| `packages/mcp-client/src/supervisor.ts` | 528 | `createMcpSupervisor` 92-528 (437 lines) | `packages/mcp-client/src/scheduler.ts`; `packages/mcp-client/src/index.ts` |
| `packages/llm-openai/src/index.ts` | 515 | `createOpenAIClient` 116-497 (382 lines); `stream` 127-495 (369 lines) | `packages/provider/src/index.ts` |
| `packages/code-mode/src/runtime.ts` | 508 | `createCodeModeRuntime` 111-508 (398 lines) | `packages/code-mode/src/register.ts`; `packages/code-mode/src/index.ts` |
| `packages/llm-anthropic/src/index.ts` | 505 | `createAnthropicClient` 199-505 (307 lines); `stream` 202-503 (302 lines) | `packages/provider/src/index.ts` |
| `packages/core-plugin/src/index.ts` | 478 | `createScope` 101-464 (364 lines) | `packages/session-executor/src/assembly.ts`; `packages/provider/src/index.ts`; `packages/subagent/src/tools.ts` |
| `packages/coding-plans/src/codex-management.ts` | 476 | `createCodexManagement` 128-476 (349 lines) | `packages/coding-plans/src/index.ts` |
| `packages/llm-bedrock/src/index.ts` | 419 | `createBedrockClient` 153-419 (267 lines); `stream` 161-417 (257 lines) | `packages/provider/src/index.ts` |
| `packages/llm-openai-compatible/src/index.ts` | 401 | `createOpenAICompatibleClient` 149-401 (253 lines) | `packages/provider/src/index.ts` |
| `packages/desktop-gateway/src/project-scope.ts` | 397 | `createProjectScopeBroker` 30-397 (368 lines) | `packages/desktop-gateway/src/host.ts`; `packages/desktop-gateway/src/types.ts` |
| `packages/exec/src/execution-supervisor.ts` | 368 → 8 (S13) | Original `createExecutionSupervisor` 89-368 (280 lines); now 6-8 (3 lines). `supervision/{contracts,admission,ownership,retirement,reconciliation}.ts` are 62/153/82/85/51 lines. Same gates and separate original audit-owner mapping as the service row. | `packages/exec/src/service.ts`; `packages/exec/src/index.ts` |
| `packages/desktop/src/main/runtime-diagnostics.ts` | 319 | `createRuntimeDiagnostics` 29-319 (291 lines) | `packages/desktop/src/main/ipc.ts`; `packages/desktop/src/main/index.ts` |
| `packages/desktop-gateway/src/session-subagents.ts` | 316 | `createDesktopSubagents` 60-316 (257 lines) | `packages/desktop-gateway/src/host.ts`; `packages/desktop-gateway/src/types.ts` |
| `packages/code-retrieval/src/service.ts` | 309 | `createCodeRetrievalService` 10-309 (300 lines) | `packages/code-retrieval/src/index.ts` |
| `packages/desktop/src/renderer/session/SessionManager.tsx` | 210 | `SessionManager` 26-210 (185 lines, 20560 chars) | `packages/desktop/src/renderer/shell/Workbench.tsx` |

### S13 actual module inventory and function review triggers

The original research measurements above remain before values; S13 arrows
record the current physical lines. The saved TypeScript AST inventory is
`task-S13-sizes.json` beside its report. Current modules have these physical
sizes, including comments and blank lines:

| Exec source module | Physical lines | Largest function AST span |
|---|---:|---:|
| `service.ts` | 11 | 5 |
| `execution-supervisor.ts` | 8 | 3 |
| `execution-host.ts` | 27 | 22 |
| `transport-launch.ts` | 96 | 47 |
| `capture/contracts.ts` | 14 | Types only |
| `capture/input.ts` | 8 | 6 |
| `capture/output.ts` | 174 | 164 |
| `capture/retention.ts` | 33 | 28 |
| `capture/completion.ts` | 98 | 67 |
| `jobs/contracts.ts` | 9 | Types only |
| `jobs/records.ts` | 138 | 127 |
| `jobs/views.ts` | 25 | 20 |
| `jobs/observation.ts` | 70 | 59 |
| `supervision/contracts.ts` | 62 | Types only |
| `supervision/ownership.ts` | 82 | 75 |
| `supervision/admission.ts` | 153 | 124 |
| `supervision/retirement.ts` | 85 | 65 |
| `supervision/reconciliation.ts` | 51 | 40 |

The three nested factory spans over the proposed 120-line review trigger are
explicit cohesive exceptions: capture/output retains synchronous capture
initialization, the sole output/input consumers and cancellation/iterator
state, with retention and completion extracted; jobs/records retains one
registry and its transition operations; supervision/admission retains the
preparation/commit fence around the same entry. These files are below the
400-line file budget and no function is 250 lines. Their shared scalars and
maps are not copied into a mutable context object. Capabilities query the
original owner after waits, and command/host/backend/handle getters and method
receivers remain at their original boundaries. E3/E6/E8 remain separate
behavioral work.

### S17 actual module inventory and ownership rationale

The original census measurements above remain historical before values. The
package and batch facades are now 21 and 4 physical lines. Agent modules are
`types` 116, `create` 36, `registry` 15, `context` 130, `turn` 102,
`step-input` 184, `model-loop` 32, `model-step` 128, `reasoning` 67 and
`finalization` 115. Batch modules are `types` 39, `prepare` 31, `dispatch` 60,
`join` 102, `record` 62 and `cancel` 129. The saved TypeScript AST inventory is
`task-S17-sizes.json` beside the report. No operation or factory exceeds the
120-line review trigger; the largest is the 119-line per-step model owner.

The added `create`, `context`, `registry`, `model-step` and batch `types` modules
are concrete responsibilities formerly in the two original files. They keep
agent operation accounting/context preferences/call-ID history separate from
turn control and each provider step's output/retry state. The turn controller
retains the original asynchronous awaits; request assembly, event folds and
reasoning methods are synchronous between them. Narrow typed capabilities query
the same live dependency objects and preserve method receivers. The batch has
separate preparation, body dispatch, rolling join, ordered record and cancellation
owners; it does not share a giant mutable locals bag or introduce a finalize latch.

The audit adapter names only exact descendants of the original agent index and
batch file, assigns every descendant once, and keeps the existing executor and
the other original owner independent. Removing the mapping or broadening the
boundary is rejected by self-test controls. The baseline and allowlist remain
unchanged. Per-model compaction-policy IDs remain an existing source gap with
one explicit skip; the inherited commit-cursor limitation after an observation
throw is preserved for later completion work. No E/I semantics were added.

### Measurement-only excluded test AST spans and compressed test containers

**Excluded from decomposition.** These lexical AST spans are retained as measurement facts only, not tasks or assertion counts. Nested `describe` callbacks overlap; existing test organization must remain unchanged.

| File | Function/container | Lines | Span |
|---|---|---:|---|
| `packages/session-executor/test/service.test.ts` | `describe callback` | 787 | 21-807 |
| `packages/subagent/test/child.test.ts` | `describe callback` | 667 | 1097-1763 |
| `packages/llm-anthropic/test/anthropic.test.ts` | `describe callback` | 609 | 5-613 |
| `packages/llm-gemini/test/gemini.test.ts` | `describe callback` | 565 | 13-577 |
| `packages/provider-runtime/test/runtime.test.ts` | `describe callback` | 564 | 277-840 |
| `packages/sandbox-windows-psec/test/fake-session.test.ts` | `describe callback` | 560 | 61-620 |
| `packages/agent-team/test/lifecycle.test.ts` | `describe callback` | 543 | 58-600 |
| `packages/core-agent/test/execute-tool-calls.test.ts` | `describe callback` | 531 | 172-702 |
| `apps/cli/test/sdk-wire-v11.test.ts` | `describe callback` | 491 | 82-572 |
| `packages/code-mode/test/runtime.test.ts` | `describe callback` | 453 | 12-464 |
| `packages/acp/test/acp.test.ts` | `describe callback` | 448 | 86-533 |
| `packages/session-persistence/test/fork.test.ts` | `describe callback` | 435 | 35-469 |
| `packages/llm-openai/test/openai.test.ts` | `describe callback` | 416 | 7-422 |
| `packages/subagent/test/tools.test.ts` | `describe callback` | 416 | 323-738 |
| `packages/subagent/test/resume.test.ts` | `describe callback` | 407 | 64-470 |
| `apps/cli/test/diagnostics-bootstrap.test.ts` | `describe callback` | 398 | 192-589 |
| `packages/llm-bedrock/test/bedrock.test.ts` | `describe callback` | 377 | 34-410 |
| `apps/cli/test/metrics-summary.test.ts` | `describe callback` | 359 | 19-377 |
| `apps/cli/test/models-command.test.ts` | `describe callback` | 357 | 208-564 |
| `packages/mcp-client/test/reconnect.test.ts` | `describe callback` | 352 | 337-688 |
| `packages/session-executor/test/assembly.test.ts` | `describe callback` | 347 | 73-419 |
| `packages/core-session/test/session.test.ts` | `describe callback` | 336 | 6-341 |
| `packages/session-persistence/test/ownership.test.ts` | `describe callback` | 329 | 78-406 |
| `packages/shell/test/shell.test.ts` | `describe callback` | 324 | 131-454 |
| `packages/desktop/test/project-git-ui.test.tsx` | `describe callback` | 319 | 45-363 |
| `packages/context-output/test/service.test.ts` | `describe callback` | 315 | 189-503 |
| `packages/mcp-client/test/sync.test.ts` | `describe callback` | 315 | 149-463 |
| `packages/plugin-registry/test/evaluate.test.ts` | `describe callback` | 306 | 34-339 |
| `apps/cli/test/cli.test.ts` | `describe callback` | 303 | 166-468 |
| `packages/mcp-client/test/oauth-real-as.test.ts` | `describe callback` | 301 | 719-1019 |
| `packages/desktop/test/ipc.test.ts` | `describe callback` | 295 | 53-347 |
| `packages/session-persistence/test/ownership.test.ts` | `describe.skipIf(process.platform !== "win32") callback` | 289 | 117-405 |
| `packages/subagent/test/tools.test.ts` | `describe callback` | 282 | 40-321 |
| `packages/guard-approval/test/guard-approval.test.ts` | `describe callback` | 281 | 32-312 |
| `packages/sandbox/test/call-policy.test.ts` | `describe callback` | 278 | 80-357 |
| `packages/session-persistence/test/repair.test.ts` | `describe callback` | 278 | 213-490 |
| `packages/sdk/test/server.test.ts` | `describe callback` | 272 | 753-1024 |
| `packages/compaction/test/engine.test.ts` | `describe callback` | 271 | 24-294 |
| `packages/settings/test/watch-events.test.ts` | `describe callback` | 270 | 127-396 |
| `packages/sdk/test/server.test.ts` | `describe callback` | 269 | 1026-1294 |
| `packages/settings/test/sections.test.ts` | `describe callback` | 261 | 363-623 |
| `packages/coding-plans/test/codex-management.test.ts` | `describe callback` | 259 | 76-334 |
| `packages/provider-runtime/test/runtime.test.ts` | `describe callback` | 258 | 842-1099 |
| `packages/session-executor/test/rewind.test.ts` | `describe callback` | 258 | 31-288 |
| `packages/sdk/test/server.test.ts` | `describe callback` | 257 | 109-365 |
| `packages/core-agent/test/agent.test.ts` | `describe callback` | 253 | 29-281 |
| `packages/llm-openai-compatible/test/openai-compatible.test.ts` | `describe callback` | 253 | 5-257 |
| `apps/cli/test/roles-command.test.ts` | `describe callback` | 250 | 145-394 |
| `packages/session-executor/test/event-driven-steering.test.ts` | `describe callback` | 235 | 55-289 (22098 chars, density candidate) |
| `packages/desktop/test/workbench.test.tsx` | `describe callback` | 249 | 59-307 (19954 chars, density candidate) |
| `packages/desktop/test/runtime-diagnostics-ipc.test.ts` | `describe callback` | 198 | 27-224 (19303 chars, density candidate) |
