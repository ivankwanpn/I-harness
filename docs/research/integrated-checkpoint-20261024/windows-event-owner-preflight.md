# N1 Windows ACL event preflight — 2026-10-24

Status: planning evidence only. No product source, tests, builds, Git state, or live processes were changed or exercised. This is not N1 acceptance, an implementation reservation, or permission to promote a platform. Root adjudicates the packet and reserves its writer later. F0 remains the sole persistence writer; this packet adds no execution/result store or delivery lane.

## Baseline and binding scope

Requested product baseline: `12cb34cf516b72914dc761c11d362c60d0add9cb`, MAIN `D:/I-harness-main`. During inspection HEAD was `e760aa52835c705e5154ee64c94cb9535b922b2c`. Read-only `git diff --name-only 12cb34cf516b72914dc761c11d362c60d0add9cb -- packages/sandbox-windows-acl packages/sandbox-local/src/windows-legacy.ts packages/sandbox/src/execution.ts packages/exec/src/capture` produced no differences. All line references below are actual inspected source lines. No AGENTS.md was found by the repository filename search.

Binding inputs are `docs/superpowers/specs/2026-10-23-v0.1.13-integrated-delivery.md`, Task 6 at `docs/superpowers/plans/2026-10-23-v0.1.13-integrated-delivery.md:93`, N1/native section of `docs/research/v0.1.13-integrated-20261023/event-rebase.md`, and `docs/refactoring/v0.1.13-native-event-gate.md`. The approved aim is removal of actual recurring healthy-state polling while preserving restrictions and separate root/tree/I/O/release facts. Necessary deadlines, error backoff, and requested scheduling remain allowed. No pure decomposition prerequisite is introduced.

## 1. Actual reachability changes the dispatch boundary

**Shipping IH ACL execution does not use `drainPipe`. Its transport and public completion already belong to the existing PSEC native wrapper. A compatibility pipe rewrite alone cannot close the shipping Windows event gate. N2's existing owner must be event driven before the combined shipping path qualifies.**

| Route / source | Actual behavior and owner |
|---|---|
| `packages/session-executor/src/assembly.ts:701`, `:738` | Assembly creates `createAssemblyExecutionRuntime` and gives its execution host to `registerExec`. |
| `packages/session-executor/src/execution-runtime.ts:25–36`, `:86–87` | Defaults Windows selection to `legacy`; supplies a temp location and `createLocalExecutionBackends`. Confined legacy automatic promotion remains `complete-tree`. Status at `:180` describes root-bound complete-tree and absence of retained descendants. |
| `packages/sandbox-local/src/execution-backends.ts:38–46`, `:60–66` | Constructs the hidden-console unrestricted native owner around the ACL runner; selects the legacy adapter for confined pipes. Full-access remains the unrestricted native owner. |
| `packages/sandbox-local/src/windows-legacy.ts:64–92` | ACL provider supplies the restricted runner argv. The native owner prepares/commits that wrapper. The adapter returns native `pid`, `io`, `rootExited`, live `settled`, `cancel`, and `release`, with the original ACL runner classification and owner-bound receipt. No second native lifecycle is assembled here. |
| `packages/sandbox-windows-acl/src/index.ts:506–520`, `:737–750` | Provider returns runner argv: source `runner.ts` via absolute tsx loader, or bundled sibling `runner.mjs`. It does not call `AclSandbox.spawn`. |
| `packages/sandbox-windows-acl/src/runner.ts:188–221` | The only in-repository `new AclSandbox` construction found. Always calls `sandbox.spawn({stdio:'inherit', ...})`, then `child.wait()`. |
| CLI `apps/cli/src/run.ts:645`; service `packages/session-executor/src/service.ts:576`, `:619` | Enter the shared session assembly. SDK server depends on `SessionService` (`packages/sdk/src/server.ts:80`). These shared execution paths do not directly select ACL pipe capture. |
| Actual bundled ACL self-check `apps/cli/src/index.ts:598–638` | Explicitly composes `createLocalExecutionBackends({windowsSelection:'legacy',legacyPrivateTempRoot})` and `createExecService`, exercising the same supervised wrapper boundary. |
| Direct public compatibility API `packages/sandbox-windows-acl/src/index.ts:113–145`, `:395–409` | `new AclSandbox(...).spawn()` defaults to `stdio:'pipe'` and calls `spawnSandboxed` + two `drainPipe`s. Repository search found no production or test caller requesting this direct class pipe path; it remains exported API, not proof of an unreachable public surface. |

The route search covered `packages`, `apps`, `scripts`, and `e2e` for `AclSandbox`, `new AclSandbox`, `spawnSandboxed`, `drainPipe`, and `waitForExit`. It found only the runner construction above. This is source reachability evidence, not an executed CLI/Gateway/Desktop certification.

Preserve existing capability refusals: `windows-legacy.ts:43` reports `retainedTree:false`; `:50–51` rejects PTY and `retain-tree`. `complete-tree` is deliberately root-bound: existing native `packages/sandbox-windows-psec/native/src/runner/running.rs:328–345` terminates remaining owned tree after root exit. Do not change this to indefinite descendant retention as an incidental event rewrite. Retained-descendant tests belong to native owner qualification under its existing supported retain-tree route; they must not advertise new ACL legacy capability.

## 2. Current ACL Win32 and completion ownership

| Actual location | Current mechanism / gap |
|---|---|
| `spawn.ts:73–86`, `:114–165` | Direct pipes use `CreatePipe(...,NULL,0)`, toggle child ends inheritable, then `CreateProcessAsUserW` with inheritance TRUE, ordinary STARTUPINFO, flags zero. No Job or suspended admission in this direct branch. |
| `spawn.ts:187–214` | Every output stream calls `PeekNamedPipe`, reads available bytes synchronously, then waits 1 ms even after useful data. This is recurring healthy-state polling, not an error backoff. On non-EOF failure, closure is not protected by a finally block. Full output is accumulated in Buffers. |
| `spawn.ts:226–233`; `index.ts:395–409` | `waitForExit` is synchronous `WaitForSingleObject(INFINITE)` + `GetExitCodeProcess` + close. Direct wait starts after both pipe drains. EOF does not imply root exit: a live root can close both handles, making the subsequent wait block the JS thread. Root may also exit before EOF held by another writer. |
| `spawn.ts:243–255`, `:291–401` | Inherited runner creates a kill-on-close Job; enables three std handle inheritance bits; creates restricted root suspended; assigns Job before resume; restores inheritability. This restriction sequence is the live shipping ACL launch path. |
| `index.ts:381–390` | Inherited `wait()` synchronously waits root and closes the inner kill-on-close Job. This kernel wait is already event based, although it blocks the runner's JS event loop. Closing Job enforces root-bound cleanup; it is not a factual tree-empty ACK. Repeated `wait()` can close Job again because only exit code promise is memoized. |
| `runner.ts:217–233` | Finally disposes token/grants/private temp after child wait. It reports cleanup failures rather than replacing child exit status. Do not free grant/token state while a new pending I/O owner still relies on it. |
| `ffi.ts:120–155`, `:416–425`; `win32-abi.ts:148–158` | Current FFI has synchronous reads/peek/root wait and basic Job operations. Missing pipe-overlapped read/result/cancel, registered wait/unregister, Job query/revalidation, startup attribute list, and private named-pipe descriptor bindings. |
| `ffi.ts:241–259` | Existing `allocBytes` uses `koffi.alloc`; `allocOverlapped` allocates a 32-byte x64 block used for locks. It is not an implemented asynchronous read owner. |

Existing confinement is built at `index.ts:302–320` through the restricted token and default DACL grant. It must remain unchanged in meaning, including current path/SID policy, error identity, environment, argv quoting, and hidden inherited console behavior. A new explicit handle whitelist and private named-pipe peer policy are **new necessary migration protections**, not security properties already implemented in ACL `spawn.ts`. The PSEC outer launcher separately has STARTUPINFOEX + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` at `native/src/runner/prepared.rs:154–182`; that does not whitelist the runner's second restricted spawn.

Public host completion stays exactly `packages/sandbox/src/execution.ts:63–109`: root observation is separate; `ExecutionSettlement.kind='settled'` requires treeEmpty, ioSettled, resourcesReleased; `cancel/release` return a settlement. `packages/exec/src/capture/completion.ts:41–75` already joins root, native settlement, output consume, input, and cancellation independently. Failure stops presentation while original native ownership survives retry. Do not replace that join, infer completion from root/EOF, or duplicate its retained-output registration (`:93–94`).

## 3. Feasible native mechanism, with local-reference limits

Local reference first: `.tmp/v0113-execution/native-probe/windows-events.cpp:33–52` owns persistent OVERLAPPED/events and overlapped named pipes; `:125–130` joins root/tree/two read ends using infinite waits; `:141–189` demonstrates member-handle fallback; `:194–208` consumes read results and targets pending cancellation. Its fixed 63-member list, bounded fixture catch-up, benign pipe descriptors, and failure shutdown at `:214–225` are not a product implementation to copy verbatim. The saved E8a report/review explicitly leave failed-cleanup storage retention and robust fallback combined with cancellation unqualified.

Installed Koffi local docs resolve an important bridge detail:

- `packages/sandbox-windows-acl/node_modules/koffi/doc/output.md:249–255`: asynchronous native output requires stable `koffi.alloc` memory, not JS Buffer/typed-array storage held past the FFI call. Allocate OVERLAPPED **and native read buffers**; copy bytes into Buffers only after result ACK.
- `.../doc/callbacks.md:81–87`, `:166–176`: delayed callbacks require `koffi.register`; native-thread callbacks are queued to JS. Blocking the JS loop waiting for those callbacks can deadlock. Callback slots and native registrations need explicit release.
- `.../doc/load.md:127–154` and `.../doc/misc.md:26–37`: `.async` dispatches native calls to bounded workers. Do not put an infinite blocking wait per pipe/member into that queue. Registered native object waits avoid using a bounded FFI worker for each healthy pending operation.

The historical `C:/Strawberry/c/x86_64-w64-mingw32/include` path mentioned in ABI comments was absent in this inspection. No header ABI verification or compilation was run. Extend the existing x64 ABI tests and verify signatures on the implementation host before adoption; do not claim the old comment proves new declarations.

Primary API cross-checks support the following design, not product acceptance:

- Overlapped named pipe handles need FILE_FLAG_OVERLAPPED, valid per-operation OVERLAPPED and manual-reset event. Retain storage through completion. [Microsoft overlapped pipe I/O](https://learn.microsoft.com/en-us/windows/win32/ipc/synchronous-and-overlapped-input-and-output).
- `RegisterWaitForSingleObject(INFINITE,WT_EXECUTEONLYONCE)` can wait process/event handles without recurring sampling. Even once-only registrations must be unregistered; do not close the underlying handle first. [Microsoft registered waits](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-registerwaitforsingleobject).
- A registered wait is not a CloseHandle handle. After the callback returns, use the asynchronous FFI form of `UnregisterWaitEx(wait,INVALID_HANDLE_VALUE)` to acknowledge callback drain; do not synchronously wait in its callback or block JS awaiting queued callbacks. Only then unregister Koffi trampoline/context and close referenced native handles. This bridge choice still needs controlled real proof. [Microsoft unregister ACK](https://learn.microsoft.com/en-us/windows/win32/api/threadpoollegacyapiset/nf-threadpoollegacyapiset-unregisterwaitex).
- `CancelIoEx` submits cancellation; ERROR_NOT_FOUND does not settle the original read. Read/result ACK may be successful bytes or ERROR_OPERATION_ABORTED. [Microsoft cancellation](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex).
- Job messages are advisory; PID identity needs retained handles. Complete PID lists grow when the returned population is truncated and include child Jobs. [Job notification contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port), [Job PID list](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list).
- New named pipes need explicit DACL/peer policy; default descriptors grant broader read rights. Only explicit child std handles enter the inheritance list; inheritance TRUE alone is insufficient. [Named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights), [handle-list attribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

## 4. Minimal executable packet and dependency order

### N1-A — live ACL runner launch and root wait, one ACL writer

Files: existing `packages/sandbox-windows-acl/src/{spawn,ffi,win32-abi,index,runner}.ts`; new small internal `src/native-wait.ts`; existing `test/{spawn,abi,ffi}.test.ts` and `test/kill-on-close.e2e.ts`. Only functional modules needed for lifetime ownership are added; no size-only split.

1. Introduce a native registered-wait owner with one-shot infinite waits, stable context identity, captured native error at its original call boundary, generation retirement, and shared asynchronous `close()`/unregister ACK. Native callback enqueues bounded owner work and returns; blocking unregister runs later through asynchronous FFI. A stale callback cannot access a retired handle/context. Keep ownership until ACK on any failure.
2. Replace inherited runner's blocking root wait with this actual process-handle wait; read GetExitCodeProcess after root signal. Memoize the entire `wait()` operation, including Job close, so callers join one closure. Preserve root-bound inner Job close and never label that close tree-empty.
3. Use STARTUPINFOEX and an explicit three-stdio-handle list for restricted spawn; preserve CREATE_SUSPENDED -> AssignProcessToJobObject -> ResumeThread. Do not copy PSEC console flags: ACL's existing console/init restrictions differ. Capture LastError before attribute cleanup/restore calls. On assignment failure terminate suspended child; preserve owned handle cleanup if termination fails.
4. Keep runner argv, token policy, source/bundled invocation, environment, exit-code mirroring and failure signatures compatible. Runner finally must await new internal async wait cleanup before disposing its owned grants. No `TransportExecutionHandle`, persistence, or protocol changes.

N1-A improves the live ACL owner and inheritance boundary, but alone removes no shipping native recurring timer: that timer lives in the N2 wrapper owner.

### N1-B — exported direct pipe compatibility path, same ACL writer, separately reported

Files: same ACL files plus new internal `src/overlapped-pipe.ts`, `test/native-wait.test.ts`, `test/overlapped-pipe.test.ts`, `test/native-events.e2e.ts`. No edits to PSEC or exec capture/store.

1. Replace stdout/stderr CreatePipe + PeekNamedPipe drains with private unpredictable named pipes, FIRST_PIPE_INSTANCE, explicit local peer/security policy, overlapped server reads, noninherited host read ends and explicit child handle whitelist. Host opens child endpoints before launch; do not expose a public rendezvous. Handle connect/synchronous-read completion races as actual operation results. Validate descriptor permissions with the existing restricted token; never add a broad Everyone write ACE to make a test pass.
2. Each channel owns `{nativeBuffer,overlapped,event,waitRegistration,operationGeneration,pending,terminal}`. Arm at most one read; handle immediate result and ERROR_IO_PENDING; await the real event and `GetOverlappedResult(FALSE)`; deliver exact bytes once; ACK/unregister before reuse/rearm/free. Terminal is proven EOF or acknowledged cancellation/error with explicit failure. No Peek, timed readiness check, or healthy timeout.
3. Observe root concurrently through native-wait, independently of both read completions. Keep existing `AclSandboxChild {pid,wait()}` result shape; `wait()` joins root plus both channels and owned closure once. This compatibility API is not a TransportExecutionHandle and has no existing tree/cancel contract. Do not manufacture one from EOF. It must not become the supervised exec backend.
4. Internal error/rollback cleanup targets each pending read with CancelIoEx, keeps storage/handle/wait registration until original result and callback-drain ACK, and retains failed owners in the original ACL owner for explicit cleanup retry. An expired cleanup deadline returns failure/incomplete to its caller without freeing the still-pending storage. Do not silently detach an unreachable cleanup promise. If the existing synchronous `dispose()` cannot represent that retained state, freeze an additive awaited close seam with root before implementation; never revoke live grants and call cleanup successful.
5. Fixed native read buffers bound in-flight I/O. Existing direct `wait()` still returns complete accumulated Buffer output and has no established output-limit policy; do not invent a limit or claim it has shipping capture backpressure. Shipping bounded output and abandoned-byte accounting remain the existing outer native transport + exec owners. If direct API memory limits must change, root must freeze that explicit API/policy change first.

N1-B is a compatibility polling replacement, not a second PSEC Job/tree supervisor. Adding a Job/tree contract or public cancellation method to the exported direct API is outside this minimal packet and requires an explicit contract decision. Suspended assignment/Job semantics on the live inherited route must remain intact throughout.

### Shipping gate order — original native owner first

1. N1-A and ACL-only N1-B work can be reserved independently after the wait/cleanup seam above is frozen; they need no persistence work. Do not dispatch them as a replacement for N2.
2. N2 must replace polling **in the existing PSEC wrapper native owner**, preserving its public transport shape. Current active polls are `native/src/runner.rs:60` (10 ms control receive); `runner/running.rs:294–347` (zero-time root/Job samples), `:426` (cleanup sleep); `native/src/transport.rs:359`, `:383`, `:562–568` (5 ms capacity retry, 10 ms input receive, thread-finished samples). These files remain N2's sole writer; this plan does not implement or widen N2.
3. N2's event owner must combine original control, real root/process-member exits, read/input/thread completion and capacity/close notifications. Job hints alone cannot complete the tree. Pin/revalidate exact owned member handles, grow snapshots, and boundedly reconcile exited-before-pin/reuse/churn/access failures; unknown remains incomplete. No duplicated ACL root/tree settlement enters `windows-legacy.ts`.
4. After reviewed N2 integration, execute controlled ACL legacy -> native wrapper -> TransportExecutionHandle -> exec capture qualification. Preserve root-bound complete-tree termination and `retainedTree:false`; no shared interface change is currently necessary. Any actual public type/protocol delta must be frozen with D3/O2 and root before writing shared files.

## 5. Tests actually present and missing cuts

These are source inventories, not newly executed passes.

| Existing test | Real coverage / limit |
|---|---|
| `sandbox-windows-acl/test/spawn.test.ts:8–70` | Quoting/cmd-verbatim and fake inherited startup failure, LastError and console flag preservation. No direct pipe drain, pending read, cancellation ACK, root/EOF join, tree, callback drain or real overlapped tests. Its exact creation-flag assertion must intentionally accommodate EXTENDED_STARTUPINFO_PRESENT while preserving suspended behavior. |
| `test/kill-on-close.e2e.ts:52`, `:88` | Real provider -> runner restriction/descendant-creation denial and target killed on runner death. It uses 100 ms test polling (`:39–47`) and `process.kill(pid,0)` (`:106`, `:121`); useful restriction/backstop controls, not a zero-product-poll oracle or retained-descendant success. Do not weaken the EPERM pin to make a descendant test possible. |
| `test/win32.e2e.ts:47–165`, `test/{pwsh,read-visibility,multi-root}.e2e.ts` | Existing actual provider confinement, grants, read boundaries, shells and root policy. These use runner inherited stdio, not direct `drainPipe`. |
| `sandbox-local/test/execution-composition.test.ts:72–120`, `:125–154` | Fake delegation retains native receipt/runner/lifecycle; retained-tree/PTY refusals and teardown retry. Protect this seam but do not treat fakes as native ACK proof. |
| `sandbox-local/test/legacy-real.test.ts:20–83` | Actual legacy public execution: exact env, shell/quoting, read-only and workspace-write behavior, settlement through handle.release. No root/EOF/cancel/backpressure adverse ordering or advisory-loss proof. |
| `sandbox-windows-psec/test/real-driver.test.ts:56–160` | Existing native public execution, input, flood cancellation without iterator, active release, disposal, authority/duplicate-commit controls. Remain N2/combined validation; they do not prove new ACL direct overlapped or callback ownership. |
| `sandbox-windows-psec/test/fake-session.test.ts:109–180`, `:391` | Concurrent/retry teardown, late release and helper-exit incomplete controls. Fakes preserve failure semantics but cannot qualify actual Win32 cancellation. |
| `exec/test/execution-contract-consumer.test.ts:381–409`; `exec/test/execution-supervisor.test.ts:293–301`, `:438` | Independent root/tree/I/O/release join, historical incomplete/retry and failure retention. Reuse as contract regression evidence after native changes; do not rewrite exec completion/result retention. |

ACL Vitest config explicitly includes both `test/**/*.test.ts` and `test/**/*.e2e.ts` (`vitest.config.ts:8`). New E2E filenames must remain in that population and report platform skips honestly.

## 6. Required controlled Windows qualification before promotion

Freeze tests and exact source/artifact manifest before execution. Preserve setup-invalid/failed logs. All process waits/cancels in the qualification harness target owned processes/Jobs/handles. Test watchdogs are one-shot failure bounds, never successful completion evidence.

1. **Actual ACL launch:** read-only/workspace-write, multi-root/no-private-temp production composition, exact env/TMP/TEMP, Unicode/cmd-verbatim, hidden inherited console, full-width exit status, original restricted child descendant-denial pin. Check explicit inherited whitelist with an unrelated inheritable sentinel handle excluded; no Job/control/wait handles leak to restricted child. Inject failure at pipe/descriptor/attributes/create/assignment/resume/wait stages; no unrestricted child and no left-suspended child.
2. **New real overlapped direct API:** pending read, immediate data, both-channel binary/large output, EOF, EOF while root still alive and root before trailing output; native root observer must not block unrelated JS work. Compare exact output bytes and one exit observation. Assert read buffer/OVERLAPPED addresses survive GC pressure and cancel race until ACK. Neither fixture source nor fake timer test substitutes for these real operations.
3. **Cancellation/error cleanup:** cancel before root exit; cancel pending stdout/stderr; completion wins cancellation; ERROR_NOT_FOUND; delayed read ACK; delayed queued callback and unregister; registration failure after read submission; native CloseHandle/termination/unregister failure. On cleanup deadline, original pending owners remain reachable and retry joins them; no second launch/read/completion or premature free. Real ACK must be observed; forced error injection alone only proves retention policy.
4. **Shipping complete-tree semantics through actual exec:** restricted root closes output while still alive; root exit triggers intended complete-tree cleanup; wrapper EOF/settled and input/resource ACK are independently ordered; original handle retained through Stop, authority revoke, release/dispose race and cleanup retry. Child exit code and partial output remain accurate, with zero extra execution. Outer termination failure stays incomplete, never success from runner close.
5. **Native tree/transport cross-gate after N2:** root-before-descendant/tail and pipe-EOF-before-tree on the existing retain-tree-capable native route; all ordinary Job messages suppressed; late grandchild; >63 members/growing snapshot; churn, exited-before-pin, PID reuse, access denial, nested Jobs/breakaway policy; cancel before root and under total advisory loss; no iterator/flood and slow iterator/capacity recovery; input/output worker ACK; transport disconnect. These are N2-owned real tests reused by combined ACL qualification, not instructions to implement those native files in N1.
6. **Healthy idle census:** instrument the actual ACL+native shipping path and direct compatibility path separately. Hold owned work alive with no output; count readiness/root/Job status API calls and timers after initial admission. Zero repeated healthy reads/samples is required. Then trigger data/EOF/root/control events and observe bounded causal catch-up. Retain source classification alongside measurements; timer text-hit count alone is not a run result.
7. **Source and packaged caller:** run affected ACL, sandbox-local, native-owner and exec contract tests; run actual session assembly execution and bundled `probeAclSeam`/runner.mjs through the same fixed candidate. Product packaging evidence is root's later integrated gate. Confirm code and artifact identity; a source-only Vitest run cannot certify the packaged runner/native executable.

Candidate commands for a future reserved implementation host (not executed in this preflight): `pnpm --filter @i-harness/sandbox-windows-acl test`, `pnpm --filter @i-harness/sandbox-windows-acl typecheck`, focused existing/new sandbox-local tests, focused native-owner tests after N2, and exec capture/contract/supervisor regressions. Root later runs the approved fixed-candidate integrated verification and packaging gate. Do not start broad builds against shared output during a planning reservation.

## 7. Timer classification and hard gaps

Remove: ACL direct `spawn.ts:210` recurring 1 ms healthy read polling. Shipping path still has N2 native polls listed above until its actual owner is replaced. A synchronous infinite root wait is a blocking design issue, not itself timer polling. Event-driven API calls made only because a real completion/control event fired, including bounded immediate reconciliation after an identity race, are causal drain work, not idle polling.

Retain: exec requested command deadline `packages/exec/src/capture/output.ts:27–40`; one-shot cancel/cleanup failure bounds; bounded error-only retry/backoff if explicitly classified. Test workload delays/watchdogs and existing test process checks do not count as product polling removal. No normal retained-work safety timeout may manufacture completion or silently kill healthy work.

Hard gaps before promote:

- Registered-wait/Koffi callback teardown bridge is feasible from documented APIs/local Koffi contract but unexecuted here. New ABI, stable native read storage and delayed callback/cancel ACK must pass controlled Windows tests before replacing the old path.
- Direct compatibility API has no established public cancellation/tree or bounded retained-output contract. Do not silently advertise one; freeze any necessary awaited-close addition and failed-owner retry route before implementation.
- E8a's four Windows successes and expected-incomplete negative are feasibility only. Its fallback+cancel, failed cleanup, scale/security and actual wrapper integration gaps remain open.
- The inherited runner already supplies kernel root waiting, while **shipping public tree/I/O/resource settlement is N2-owned**. N1-A/B alone cannot establish full shipping native event behavior; no duplicate supervisor is justified.
- No Windows run, test pass, CPU/ETW result, build or packaged acceptance was obtained by this task. No Linux/WSL/Darwin work or result is included. Windows success would qualify only its tested backend/routes; other native platforms remain separately unverified until their approved gates run.

Recommended root disposition: accept this as a bounded dispatch plan after reviewing the native-wait/cleanup seam; reserve ACL files to one N1 writer and native wrapper files to N2. Prioritize N2 for the shipping polling blocker. Record N1-A launch/wait changes and N1-B compatibility polling removal separately, then qualify their combined public shipping path on one integrated candidate. Do not mark N1, Task 6, full-native-event behavior, or v0.1.13 complete from this document.
