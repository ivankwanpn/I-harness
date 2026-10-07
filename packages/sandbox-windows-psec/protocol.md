# Native helper private protocol, version 1

This protocol is private to `@i-harness/sandbox-windows-psec`. A trusted TypeScript driver starts the shipped helper once for one prepared workload and continuously consumes both output pipes. Runtime never builds or downloads the executable. Validate `manifestVersion`, `protocolVersion`, target, executable SHA256 and protocol version before starting it. The manifest is a release integrity record, not a signature or authority grant.

## Streams and finite bounds

* Helper stdin: newline terminated UTF8 JSON commands. Maximum line **262144 bytes including newline**. One object per line; no BOM, NUL terminators or evaluated expressions. Unknown top level and nested fields are rejected. Malformed input terminates/rolls back the owned workload. An unterminated final line is malformed.
* Helper stdout: UTF8 JSON status lines, each at most **65536 bytes excluding newline**. No workload output belongs on this pipe. The helper duplicates its protocol descriptors as noninheritable private handles and clears all three process std-handle slots. Pipe children receive a three-handle whitelist; ConPTY children receive only the pseudoconsole attribute with ordinary inheritance disabled.
* Helper stderr: binary frames, each `channel:u8`, `length:u32 little endian`, followed by exactly `length` bytes. Channels **0 stdout**, **1 stderr**, **2 PTY**, **3 output-end**. Data lengths are 1..16384; output-end length is exactly zero. Pipe streams preserve each channel's byte order; cross-channel interleaving is not a total process-write order. PTY combines console output into channel 2.
* Control queue: 16 commands. Input queue: 8 requests of at most 16384 bytes each, plus one in progress. Frame queue: 32 frames of at most 16384 bytes each, plus one per reader and one writer in progress. No normal-execution output is intentionally discarded. Driver must apply its own output storage limit and continuously drain the binary stream independently of an attached display/iterator.
* IDs: unique within the helper, 1..128 ASCII characters `[A-Za-z0-9_.:-]`; at most 65536 requests per session. `protocol` and `helper` are reserved event IDs and should not be used by the driver. Invalid/duplicate requests do not authorize another launch.

All commands have `version:1`, `id:string`, `type:string`. The following fields are the complete command schema; omitted optional fields may also be JSON `null`. Integers must be JSON integers. Byte arrays cannot contain values outside 0..255.

## Prepare and commit

`prepare` fields:

```ts
{
  version: 1; id: string; type: "prepare";
  engine: "psec" | "unrestricted";
  consoleMode?: "no-window" | "hidden-console" | null; // immutable trusted adapter configuration
  spec: {
    argv: string[]; // argv[0] is the exact executable, not a PATH lookup
    cwd: string;
    env: Record<string,string>; // complete explicit environment, no inheritance/default injection
    owner: { sessionId: string; parentSessionId?: string | null };
    transport: "pipe" | "pty";
    lifetime: "complete-tree" | "retain-tree";
    argumentEncoding: "crt" | "cmd-verbatim";
    pty?: { cols: number; rows: number } | null;
  };
  policy: {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    owner: { sessionId: string; parentSessionId?: string | null };
    authorityRevision: string; authorityKind: "unbound" | "bound";
    primaryRoot: string; readable: "caller";
    authorityRoots: string[]; writeRoots: string[]; referenceRoots: string[];
    fingerprint: string;
  };
  protection: {
    readOnlyPaths: string[]; // immutable trusted driver/runtime restrictions
    denyPaths: string[]; // immutable trusted host restrictions
    helperSha256: string; // lowercase SHA256 of the actual running executable
  };
}
```

PSEC accepts only read-only/workspace-write. Unrestricted accepts only danger-full-access and rejects nonempty referenceRoots, readOnlyPaths or denyPaths: it cannot enforce those locks. Its helper hash is an integrity check, not filesystem protection. Neither engine retries another engine or changes policy on a launch error.

`consoleMode` is a private trusted host/adapter field, not public ProcessSpec or a model grant. Omission/null means `no-window`: pipe workloads use CREATE_NO_WINDOW; PTY workloads use their pseudoconsole without CREATE_NO_WINDOW. `hidden-console` is admitted **only for unrestricted + pipe** and creates a real console using CREATE_NEW_CONSOLE plus STARTF_USESHOWWINDOW/SW_HIDE, while preserving the exact three workload handles, suspended Job assignment and private protocol separation. It is intended for a later trusted legacy-runner adapter that requires inherited console kernel state. It cannot be selected as a PSEC/PTY fallback and never changes the engine. The mode is immutable and included in effectivePolicyDigest. Native controls observe GetConsoleWindow nonnull and IsWindowVisible false for the root and retained descendant; default pipe controls observe no console. This primitive does not suppress arbitrary GUI windows, qualify all legacy children, or prove absence of all transient UI events; later GUI WinEvent/legacy integration checks remain required.

**PSEC + PTY is rejected before preparation/launch** with `unsupported-transport`; PSEC advertises `pty:false`. On Windows 26200 the confined ConPTY combination reached CreateProcessW/Job assignment/resume but twice failed to reach a child's first println or produce any PTY bytes in 10 seconds. Resize/cancel succeeding was insufficient execution proof. No capability/attribute/ACL relaxation was attempted. A future implementation must independently prove first output, input, retention, isolation and cleanup before enabling it. Unrestricted ConPTY passed those application/lifetime controls. During qualification, redirected parent standard-handle slots caused child text to appear on the helper's status stream even with ordinary inheritance disabled; private descriptor detachment fixed that defect, and actual input/retention smokes now exercise this separation.

`argv` contains 1..4096 NUL-free strings; the encoded command line is at most 32766 UTF16 units. `crt` uses the usual Windows CRT backslash/quote encoding for every argument, including empty strings. `cmd-verbatim` requires exactly `[absoluteCmdExe,"/d","/s","/c",rawCommand]` (switch comparison ignores case); the final raw command is appended unchanged after `/d /s /c `. The caller must supply any intended cmd outer quoting. Environment keys must be nonempty, case-insensitively unique, and contain neither `=` nor NUL; values contain no NUL. The environment block is case-insensitively sorted and double NUL terminated, limited to 32767 UTF16 units. No TEMP, TMP, LOCALAPPDATA, PATH or other writable directory is synthesized. On the tested Windows 26200 host, PSEC CreateProcessW fails with **203 / ERROR_ENVVAR_NOT_FOUND** when explicit `LOCALAPPDATA` is missing. The driver must preserve this failure or provide an explicitly authorized environment; adding an environment path never adds a filesystem write grant.

Paths must be existing absolute local drive paths (`C:\...` or `C:/...`), without NUL, device/UNC prefixes or alternate streams. All policy/protection lists have at most 128 entries. Filesystem identities are canonicalized and held open without delete sharing during preparation, and canonical path/volume serial/file index plus helper content hash are rechecked immediately before CreateProcessW. This is not a claim of complete reparse/hardlink race safety. Future paths and nonlocal paths fail admission. Spec and policy owners must match. Every write root is inside an authority root; reference/write overlaps are rejected. A write root at or below a protected readonly root is rejected. More specific readonly/deny rules under an allowed write root are serialized as restrictions. The executable and cwd cannot be denied.

PSEC native policy uses schema 1.0, ordinary `PSEC` FlatBuffer, registryRead capability, Win32k allowed, UI restrictions 0, declared writes only, caller-visible volume roots readonly, explicit deny paths, and explicit network egress default deny. The native helper executable is automatically readonly. It does not grant separate read credentials or implicitly writable TEMP. Network enforcement and filesystem escape resistance require separate qualification; PSEC remains experimental.

`prepare` creates owned PSEC (only for psec engine), Job and transport. No workload is launched. Only one prepare attempt is accepted, even if it fails. Success:

```json
{"version":1,"id":"p1","type":"ready","effectivePolicyDigest":"<64 lowercase hex>","policyFingerprint":"<unchanged common fingerprint>","helperSha256":"<64 lowercase hex>"}
```

`effectivePolicyDigest` is SHA256 over the native canonical effective spec, policy, protection, explicit engine, consoleMode and serialized schema digest. It is distinct from the common authority compiler's `policyFingerprint`. Treat the digest as opaque; never relabel the common fingerprint or recompute this native digest with a guessed serializer.

`commit` has one field: `effectivePolicyDigest:string`, exactly from ready. The driver runs its final authority/abort fence immediately before sending this single command. Commit consumes the prepared specification, including on failure. It rechecks identities, creates the process suspended, assigns it to the owned Job, then resumes it. The Job uses KILL_ON_JOB_CLOSE and never BREAKAWAY_OK. Failed assignment terminates/reaps the unassigned suspended child. No partial launch is acknowledged. Success:

```json
{"version":1,"id":"c1","type":"started","pid":12345}
```

## Active commands and acknowledgements

| Type | Additional fields | Successful response |
| --- | --- | --- |
| `input` | `data:number[]`, at most 16384 bytes | `ack` with the request ID after native write finishes |
| `end-input` | none | `ack` after host input closes; later writes rejected |
| `resize` | `cols`, `rows`, integers 1..1000 | `ack`; active PTY only |
| `signal` | `signal:"INT"\|"TERM"\|"KILL"` | `ack`; TERM/KILL terminate the Job, INT queues byte 3 to PTY input; INT unsupported for pipes |
| `cancel` | `reason:"cancelled"\|"timeout"\|"output-limit"\|"authority-revoked"\|"shutdown"` | `ack` after stop requested; settlement follows independently |
| `release` | none | `released` after tree empty, I/O joined and resources released |

`ack` has only the common version/id/type. Input writes run on a separate bounded writer. A full queue returns `error.code="input-backpressure"`; no bytes from that request were queued, so the driver can retry under a new ID after outstanding acknowledgements. Pending writes interrupted by cancellation get individual error responses. `end-input` is ordered behind prior queued writes. Input ack means accepted by the native pipe, not consumed by the workload. PTY applications must initialize their console input before application-level input expectations; the smoke waits for the child's ready marker.

`cancel` before commit rolls back preparation. `release` before commit also rolls back, replies released and exits. Release while active requests termination and cancellation output drainage; release after io-settled simply closes remaining owned resources. Multiple release requests queued before completion each receive the same release result. A client can always close control stdin to request termination/rollback.

## Lifecycle events

Events below use the successful **commit request ID**, except released uses the release request ID (or commit ID on control EOF). Root exit alone does not settle the tree. Retain-tree preserves Job, PSEC and HPCON until descendants naturally exit or cancellation occurs. Complete-tree terminates remaining descendants when the root exits.

```ts
{ version:1; id:string; type:"root-exit";
  exitCode:number|null; observationError:NativeError|null }
{ version:1; id:string; type:"tree-empty"; activeProcesses:0 }
{ version:1; id:string; type:"io-settled";
  outputAbandoned:boolean; discardedBytes:number; errors:NativeError[] }
{ version:1; id:string; type:"released";
  resourcesReleased:boolean; errors:NativeError[] }
```

Tree-empty means QueryInformationJobObject basic accounting returned ActiveProcesses == 0. I/O-settled means the input/output/read workers and asynchronous ClosePseudoConsole worker have finished and joined. ClosePseudoConsole happens after tree empty with readers still draining, so its final output can be captured. The helper retains native resources after normal io-settled until `release`; the driver should send release once it has independently observed root/tree/I/O completion. The resource-release result is false if explicit CloseHandle reports failure. Nonempty I/O errors, failed release or unexpected helper exit must remain visible as incomplete/error diagnostics; helper disappearance is never proof of settlement.

Normal completion requires **both** io-settled with outputAbandoned false **and** a valid binary output-end frame. Status and binary pipes can be delivered to JavaScript in either order. Keep draining until both observations are received.

After an explicit cancellation request (cancel, TERM/KILL, active release, control EOF, or rollback/error shutdown), the helper may set **outputAbandoned true** and cancel a blocked binary writer. This is not normal successful delivery. Only this trusted status authorizes the decoder to discard a partial final binary frame or accept missing output-end. `discardedBytes` counts workload payload bytes skipped by readers/writer after abandonment, including the full payload of an interrupted frame whose partial OS write cannot be measured; it is a conservative delivery-loss count, not an exact byte offset. Framing bytes are excluded. A write may have partly reached the host, so this count can exceed bytes actually lost. Queues remain bounded; the total count can grow as already-running descendants produce output until the Job empties. No further binary frame parsing should be relied on after abandonment.

Cancellation must never wait for a display consumer or blocked workload stdin. The helper repeatedly cancels synchronous writer I/O while owning/draining readers. Failure to settle cancellation in 10 seconds returns `settlement-incomplete`, performs bounded best-effort cleanup, and exits unsuccessfully without fabricated tree/I/O/release confirmation. A driver must preserve this incomplete result.

## Errors, discovery and fixtures

```ts
type NativeError = {
  code: "invalid-request" | "invalid-state" | "native-failure" |
        "io-failure" | "input-backpressure" | "settlement-incomplete" | "unsupported-transport";
  api: string; nativeCode: number|null; detail: string; cleanup: NativeError[];
};
// response to a request, or reserved "protocol" / "helper" fatal ID:
{ version:1; id:string; type:"error"; error:NativeError }
```

HRESULTs are represented as unsigned 32-bit nativeCode so their hex value is preserved. Error detail identifies the operation without echoing environment values, command text, or private filesystem paths. Preserve api/nativeCode/cleanup causes in driver diagnostics. Prepare/commit errors never trigger a less constrained retry. Malformed control and EOF initiate owned teardown; invalid state/unsupported active requests return a per-request error.

`--probe` performs readonly API discovery and emits one JSON object. `--create-close` is an explicit native qualification mode that creates/closes a minimal readonly PSEC; it is not a runtime availability probe. `--self-child` is a separate executable fixture mode, never an operation selectable by private control input. Qualification controls write only newly created `.tmp/sandbox-redesign-*` workspace fixtures. These flags are not commands in protocol version 1.

The probe object has `version:1`, `helperVersion:"0.1.0"`, `target:"x86_64-pc-windows-msvc"`, `psecDiscovery:boolean`, `supportFlags:number`, `error:NativeError|null`, `assurance:"experimental"`, and `engines`. Each of `engines.psec` and `engines.unrestricted` has booleans `available`, `writeIsolation`, `readIsolation`, `denyPaths`, `pipes`, `pty`, `retainedTree`, `hiddenConsole`. For PSEC, availability and write/deny discovery depend on API flags; readIsolation, pty and hiddenConsole are false. For unrestricted, available/pipes/pty/retainedTree/hiddenConsole are true and all isolation/deny flags are false. hiddenConsole is conditional on pipe transport and is not a public model capability. API discovery does not execute a workload or confer verified assurance.
