# Windows execution driver and PSEC qualification

Date: 2026-10-07 (Asia/Hong_Kong). This implements the approved package redesign after the foundation and shared runtime phases. It is not permission to create accounts, change reference ACLs, elevate, install services or relax an execution policy.

Native facts and pinned primary-source ABI research: `.superpowers/sdd/2026-10-07-sandbox-foundation/native-api-map.md`. Use the generated schema, not Microsoft's broad learning-mode runner or Codex fallback dispatcher. Windows build26200 discovery reported APIset/exports and support flags0x3; that is discovery only. The upstream MXC README marks profiles as preview and not security boundaries. Keep PSEC assurance experimental even after behavioral tests; no default promotion or security-boundary claim.

## Package and protocol

Create `packages/sandbox-windows-psec/` with public TypeScript exports, package scripts/tests/typecheck, and `native/` Rust crate. Only this package knows Win32/PSEC/ConPTY or helper transport. Dependencies flow to `@i-harness/sandbox`, never to exec/shell/terminal. The same executable and manifest ship to CLI and Desktop. Runtime never builds or downloads it.

Public exports:

```ts
export interface WindowsExecutionOptions {
  helperPath?: string
  manifestPath?: string
  /** Trusted host configuration, detached/frozen when the backend is created. */
  denyPaths?: readonly string[]
}
export function createWindowsPsecBackend(options?: WindowsExecutionOptions): TransportExecutionBackend
/** Explicitly unrestricted token, still owning the native Job and transport. No PSEC fallback. */
export function createWindowsUnrestrictedBackend(options?: WindowsExecutionOptions): TransportExecutionBackend
```

PSEC backend accepts only `read-only`/`workspace-write`; unrestricted backend accepts only `danger-full-access`. PSEC probe reports experimental write isolation when API discovery succeeds, caller-visible reads, deny-path availability, pipe/PTY/retained-tree capabilities; unrestricted probe reports no write/read isolation. Failed helper integrity/version/API requirements are unavailable. Never retry with another mode, runner or omitted attributes.

Version1 private helper protocol: stdin newline JSON commands; stdout bounded newline JSON status only; stderr binary workload-output frames (`u8 channel`, little-endian u32 byte length, exact bytes; channel0 stdout,1 stderr,2 pty,3 output-end with zero length). No workload may inherit the helper's control/status descriptors. Input bytes travel as bounded JSON byte arrays, not evaluated strings. Per-command/frame bounds, one launch, matching request IDs, explicit errors, deterministic teardown on control EOF, and no partial launch acknowledgment.

Commands use `{version:1,id:string,type:string,...}`; statuses use the same version/id plus type and bounded structured fields. `prepare` supplies immutable spec/policy and explicit engine (`psec`/`unrestricted`); helper creates its owned Job/PSEC/transport and replies `ready`, with no workload. `commit` consumes the one prepared specification; create suspended, assign Job before resume, then reply `started` with actual PID. `input`, `end-input`, `resize`, `signal`, `cancel`, `release` act on that one workload. Status includes `root-exit`, `tree-empty`, `io-settled`, `released` and structured sanitized failure diagnostics. Driver commit runs the final authority/abort fence immediately before sending the single commit command. Abort, control EOF or commit failure triggers owned rollback/termination, never an unconfined retry. The Rust task writes a complete `protocol.md` field schema/examples for the TypeScript consumer; no implicit field names are left to guess. `--probe` is readonly discovery; a separate `--self-child` fixture mode is for native controls and never entered by an untrusted protocol command.

Capture exact executable, argv, `argumentEncoding` (`crt` or `cmd-verbatim`), cwd, explicit environment and PTY dimensions. Reject malformed/NUL/relative platform paths and invalid sizes. Validate all policy roots and canonicalize existing filesystem identities before prepare; compare again before commit. Do not turn lexical normalization into a reparse-safety claim. No implicit writable TEMP in readonly; workspace-write only writes declared roots. Read visibility uses available volume roots under the ambient caller token, not a new read credential. Keep references readonly; reject overlapping reference/write roots per compiler contract. Protect helper/runtime inputs from workload mutation when they sit within a writable root; unsupported carveout/deny behavior fails admission rather than dropping protection.

Driver-derived readonly helper/runtime roots and trusted immutable `denyPaths` are additional restrictions, not model-provided grants. Include their canonical rules and helper identity in a separately recorded native effective-policy digest returned by `ready` and validate that digest at commit. The common policy fingerprint remains the authority compiler's fingerprint; it must not be relabeled as a digest of platform-derived rules. The private prepare schema has explicit `protection` fields for these restrictions, so native deny-subtree controls can test real enforcement. Never accept runtime changes that remove protection on an existing prepared/active driver.

## Native resource rules

- Rust dependencies pin generated `process_security_environment_spec` Git6cd3d58f05d3447e67109cfb75e042803b843ca4, flatbuffers25.12.19, windows-sys0.61.2 and serde/serde_json; commit Cargo.lock and schema provenance. No accounts/learning/network proxy dependencies.
- Load system32 processmodel.dll with safe search, require official APIset, hold DLL for function lifetimes. PSEC HRESULT and attribute0x20023/boxed HANDLE/alignment semantics follow the research map. Ordinary FlatBuffer, flags0, schema1.0; controlled registryRead/Win32k policy only. Network egress deny is explicit and must be qualified, not inferred from empty configuration.
- Job has KILL_ON_JOB_CLOSE, no BREAKAWAY_OK. No output/error fallback to CreateProcess without PSEC. Suspended child must join Job before resume. A failed assignment must terminate/reap the unassigned child. Kernel Job accounting ActiveProcesses0 confirms tree emptiness. Root exit alone never closes PSEC/Job/ConPTY for retain-tree.
- Pipe child inherits only its three workload handles. ConPTY child uses pseudoconsole attribute, no ordinary stdio inheritance or CREATE_NO_WINDOW. Keep host input/output and HPCON alive after root exit while descendants exist.
- Output readers run concurrently with root/tree/control. Workload output backpressure cannot block status/cancel. ClosePseudoConsole may emit a final frame; drain concurrently. Release PSEC and native handles only after tree empty and I/O settled. Native failures retain useful API/error codes and cleanup causes. Helper unexpected exit cannot be fabricated into confirmed settlement.
- Full tree completion kills remaining descendants only for complete-tree lifetime; retain-tree permits natural descendant completion or explicit cancellation. Retaining/transferring presentation never respawns.

## Task 1: Rust owned native helper

**Own files:** new package `native/` Rust sources/Cargo.toml/Cargo.lock, helper build script, native artifact/provenance manifest, package.json scaffold, README native design, protocol.md, and a focused native-helper smoke script under its test/. No edits to existing packages. Split Rust into ffi/policy/command-line/job/transport/runner modules; one entrypoint delegates, not one giant source file.

- [ ] Compile and unit-test argument quoting, malformed protocol/spec rejection, finite bounds, lifecycle ownership and schema serialization. Capture RED/GREEN where behavior is testable without Windows API.
- [ ] Implement native protocol above and probe mode with readonly API discovery. The explicit unrestricted engine shares ownership/I/O but never instantiates a PSEC, and cannot accept confined policies.
- [ ] Build via installed Rust/MSVC toolchain without elevation or dependency installation. Build helper into this package's owned artifact directory. Record source/dependency/protocol/helper hashes and exact versions. No runtime compiler.
- [ ] Real minimal PSEC create/close and helper self-child: stdout/stderr/env marker/exit17. All mutations stay under a new `.tmp/sandbox-redesign-*` fixture inside the workspace. Inspect token properties as observations, not assumptions. Test whole Job cancellation and cleanup after a root with delayed descendants. Record actual supported/failed facts; stop claiming support if creation fails.
- [ ] Independent native review checks attribute alignment, handle inheritance, no breakaway/fallback, suspended launch cleanup, tree accounting, simultaneous output drain and close order. Do not change external ACLs or run privileged setup.

## Task 2: TypeScript backend over the real helper

**Own files:** new package src/ (driver, protocol decoder, helper integrity loader), tests, tsconfig, package manifests/workspace lock entry as needed. Update its README. Consume only sandbox public exports.

- [ ] Fake protocol RED: corrupt frames/oversized payload/version/hash mismatch, prepare abort/rollback, authority change just before commit (no workload), duplicate commit/release, early errors, unknown root, incomplete tree/I/O/release and retry. Bound output buffering before the one iterator attaches; apply backpressure without silently dropping bytes.
- [ ] Real prepare/commit returns actual PID/I/O and `createExecutionLease` driven by native root/tree/I/O/resource facts. Preserve experimental/unrestricted receipt assurance and immutable policy fingerprint/owner. Cancel/release wait for actual acknowledgements. A crashed helper reports incomplete cleanup rather than inferred tree emptiness.
- [ ] Pipe write/end-input, PTY write/resize/signal route through owned protocol. No IPty/Win32 types escape package. No new backend chosen after failure.
- [ ] Public consumer typecheck and real helper smoke through `exec.launchExecution`/supervisor (test-only workspace dependency declared). Commit sources/manifests and exact evidence.

## Task 3: Behavioral qualification and integration requirements

**Own files:** package qualification script/tests/fixtures, package README and `docs/audit/2026-10-07-windows-psec-qualification.md`; focused repair of native/driver findings only after root ruling.

- [ ] Real controls and negatives for workspace rw, sibling external reference ro, read-only writes, denied protected subtree, junction/alias escape attempts, absolute cwd/argv/env, full-width exit codes, stdin/binary stdout/stderr, output cancellation, timeout, root exit with descendant retention, Job cancellation and no owned process remaining.
- [ ] Test actual Git/MSYS Bash and Node/tsx with pipes. Test ConPTY input/resize and descendant lifetime. Native PowerShell/CMD controls distinguish engine failure from tool compatibility. Do not mark incompatible tests as pass by silently using unrestricted execution.
- [ ] Loopback host-positive-control versus PSEC egress denial. Record network behavior only when observed. No upstream maturity/default-security overclaim.
- [ ] Verify references unchanged by host content/metadata/hash checks. Preserve failing owned fixtures when useful, clean only this phase's verified absolute fixture paths using native PowerShell operations; do not revisit earlier prohibited cleanup.
- [ ] Export truthful qualification outcome and explicit selection requirements for the production migration plan. PSEC stays opt-in experimental; current default Windows legacy remains explicit until a separate assurance decision.

## Production migration and distribution remain required

After this driver is reviewed, migrate exec and terminal services, explicit project authority/revocation, actual child owner identity, local/legacy selection, and CLI/Desktop helper distribution. Complete real composed tests before claiming the user's Bash/runtime issue resolved. Existing legacy runner must be wrapped through this supervisor with honest unsupported capabilities; reference ACLs remain unchanged. No push/release requested for this redesign phase.
