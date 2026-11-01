/**
 * Windows ACL write-restriction sandbox backend for the DeepSeek Harness
 * sandbox seam. Mirrors the mechanism of github.com/huoyaoyuan/
 * windows-acl-restrict-poc @ 10e4dfb (the fixed revision): a WRITE_RESTRICTED
 * token whose restricting SIDs include distinct workspace and temp write
 * SIDs that this sandbox adds to their owning directories' DACLs — the
 * intersection check then allows writes exactly where either capability has
 * a Write ACE, and nowhere else those SIDs are concerned (the check ALSO
 * inherits the ambient write ACEs of the other restricting SIDs — the
 * keep-alive group logon SID + Everyone; Authenticated Users, INTERACTIVE,
 * and LOCAL are absent from both lists — see the seam's dual-list contract
 * in `packages/sandbox/sandbox-local` and the package README's Modes section
 * for the complete boundary). The write SID is the per-WORKSPACE identity
 * ({@link workspaceWriteSid}): deterministic from the canonical workspace
 * path, so the workspace-root ACE materializes once per workspace per
 * machine and every later provision hits the exact-ACE skip — the
 * grant-reuse story the per-session random SID paid a full tree propagation
 * per session for. Each private temp directory instead receives its own SID,
 * so sibling sessions sharing a workspace cannot enter one another's temp
 * trees. Unlike the POC, every API failure throws with the API
 * name and exact Win32 code; a child is NEVER spawned unrestricted.
 *
 * Known boundaries (inherent to restricted tokens, not this port):
 *  - writes are restricted; reads, network, and process visibility are NOT
 *    (WRITE_RESTRICTED intersects only write accesses);
 *  - console isolation is unavailable — children share the host console
 *    (CREATE_NO_WINDOW / CREATE_NEW_CONSOLE children die with
 *    STATUS_DLL_INIT_FAILED under the restriction);
 *  - the private temp directory and every writable directory must be owned by the
 *    caller (owner-implicit WRITE_DAC);
 *  - grants are standing ACE mutations on real directories. WORKSPACE grants
 *    are deliberately never revoked — the ACE is the cross-session reuse
 *    cache (revoking would force the next session to re-propagate the whole
 *    tree). TEMP grants are revocable: dispose() removes them so a standing
 *    inheritable ACE never outlives its session's temp directory. The
 *    ambient temp root is never granted implicitly. With `manageDacls: false`
 *    the CALLER owns the DACLs (the sandbox seam's grant reuse):
 *    init()/dispose() skip grant/revoke entirely and the caller must not
 *    revoke under live children.
 * @module @i-harness/sandbox-windows-acl
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SandboxUnavailableError, workspaceRoots, type ConfinedArgv, type ProcessSpec, type SandboxPolicy, type SandboxProvider } from '@i-harness/sandbox'
import { grantWrite, revokeWrite } from './acl.ts'
import { Win32Error } from './errors.ts'
import { win32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { NativeInitOwner, NativeInitializationFailure, NativeCleanupFailure } from './init-owner.ts'
import { AclWriteGrant } from './grant.ts'
import { assertPrivateTempDisjoint, assertTempRootOutsideWorkspace } from './path-boundary.ts'
import { buildCommandLine } from './spawn.ts'
import { createInheritedChildOwner } from './inherited-child.ts'
import { createPipeChildOwner, type PipeChildOwner } from './pipe-child.ts'
import { logonSidText } from './pipe-sid.ts'
import { acquireWaitDrainBridgeClient } from './native-wait-bridge.ts'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken, setTokenDefaultDaclGrant } from './token.ts'
import { tempWriteSid, workspaceWriteSid } from './workspace-sid.ts'
import * as abi from './win32-abi.ts'

export { quoteArg } from './spawn.ts'
export { AclWriteGrant } from './grant.ts'
export { assertTempRootOutsideWorkspace } from './path-boundary.ts'
export { tempWriteSid, workspaceWriteSid } from './workspace-sid.ts'
export { Win32Error } from './errors.ts'
export { NativeInitializationFailure } from './init-owner.ts'
export { scanWorldWritable, type WorldWritableFinding, type ScanOptions } from './audit.ts'

/** Construction options: the workspace/temp allowlists and their distinct SID identities. */
export interface AclSandboxOptions {
  /** Directories the confined child may write into (must exist and be caller-owned). */
  writableDirs: readonly string[]
  /**
   * Existing private temp directory to grant. Workspace-write callers must
   * pass it explicitly or pass null to disable temp writes; the ambient temp
   * root is never an implicit grant. Read-only accepts only null/undefined.
   */
  tempDir?: string | null
  /**
   * Legacy single workspace write SID. Supply this or writeSids under
   * workspace-write; both must be absent under read-only. Callers
   * derive it from the workspace via {@link workspaceWriteSid} — the identity
   * is per workspace, not per sandbox instance, so the workspace-root ACE
   * outlives every instance and later provisions hit the exact-ACE skip.
   */
  writeSid?: string
  /** One distinct workspace SID per writable directory, in the same order. */
  writeSids?: readonly string[]
  /**
   * The private temp directory's write SID. Required whenever
   * workspace-write grants a temp directory, absent otherwise. It must be
   * distinct from {@link writeSid}, so sibling sessions sharing a workspace
   * cannot use the standing workspace capability in one another's temp tree.
   */
  tempWriteSid?: string
  /**
   * The file-effect mode this instance confines under — selects the
   * restricted token's restricting-SID list (I for read-only, J for
   * workspace-write) and MUST match the grant shape: read-only pairs with
   * zero grants. The runner validates the argv-borne mode string at its
   * boundary; this typed seam trusts the union.
   */
  mode: 'read-only' | 'workspace-write'
  /**
   * Whether this instance owns its DACL grants (default true). False means
   * the CALLER has already materialized the ACEs (the sandbox seam's
   * workspace/temp capability lifecycle): init()/dispose() skip grant/revoke entirely —
   * the caller holds the grants for its own lifetime and revokes them.
   */
  manageDacls?: boolean
}

/** Per-spawn options: the program, its argv/cwd, and the stdio shape. */
export interface AclSandboxSpawnOptions {
  /** Program to run (resolved via PATH search when unqualified, like CreateProcess). */
  command: string
  /** Arguments, quoted per CommandLineToArgvW rules. */
  args?: readonly string[]
  /** CRT by default; cmd-verbatim preserves one raw cmd.exe /d /s /c tail. */
  argumentEncoding?: ProcessSpec['argumentEncoding']
  /** Trusted hidden-console runner: preserve hidden presentation with inherited stdio. */
  windowsHide?: boolean
  /** Working directory; defaults to the caller's cwd. */
  cwd?: string
  /**
   * 'pipe' (default): capture stdout/stderr via overlapped output pipes.
   * 'inherit': the child inherits the caller's stdio directly (runner usage —
   * bytes flow straight through), always wrapped in a kill-on-close job so the
   * child dies with the caller; stdout/stderr in the result are empty.
   */
  stdio?: 'pipe' | 'inherit'
}

/** A settled confined child: captured stdio and the exit code. */
export interface AclSandboxChildResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

/** A running confined child: its pid and a settlement promise. */
export interface AclSandboxChild {
  /** Child process id. */
  pid: number
  /** Resolve stdout/stderr and the exit code once the child exits. */
  wait(): Promise<AclSandboxChildResult>
}

/**
 * One write-restricted sandbox instance: token + write-SID grants + spawn.
 * `init()` is fail-closed — failures attempt revocation and retain unresolved
 * cleanup on this instance through NativeInitializationFailure. `dispose()` revokes the temp grants, leaves the
 * standing workspace ACEs in place (the cross-instance reuse cache), frees
 * every allocation, and reports every cleanup failure. With
 * `manageDacls: false` the caller owns the grants (the sandbox seam's grant
 * reuse): init() applies none and dispose() revokes none.
 */
export class AclSandbox {
  /** Absolute writable directories (constructor-validated). */
  readonly writableDirs: string[]
  /** The workspace SID string whose ACEs form the workspace allowlist. */
  readonly writeSid: string | undefined
  readonly writeSids: readonly string[]
  /** The private temp directory's write SID (workspace-write with temp only). */
  readonly tempWriteSid: string | undefined
  /** The file-effect mode — the restricted token's restricting-SID list selection. */
  readonly mode: 'read-only' | 'workspace-write'
  private readonly tempDirOption: string | null | undefined
  private readonly manageDacls: boolean
  private tempDirResolved: string | null | undefined
  private api: Win32Bindings | undefined
  private token: NativePtr | undefined
  private writeSidPtr: NativePtr | undefined
  private writeSidPtrs: NativePtr[] = []
  private tempWriteSidPtr: NativePtr | undefined
  /** The well-known/logon SID allocations init() makes; freed by dispose() alongside the write SIDs. */
  private initOwner: NativeInitOwner | undefined
  private initializing = false
  private initialization: Promise<void> | undefined
  private ready = false
  private closing = false
  private disposal: Promise<void> | undefined
  private logonSid: string | undefined
  private readonly pipeChildren = new Set<PipeChildOwner>()
  private grantedPaths: Array<{ path: string; sidPtr: NativePtr }> = []

  constructor(options: AclSandboxOptions) {
    this.mode = options.mode
    this.manageDacls = options.manageDacls ?? true
    this.writableDirs = options.writableDirs.map((directory) => {
      const absolute = resolve(directory)
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        throw new Error(`AclSandbox writable dir does not exist or is not a directory: ${absolute}`)
      }
      return absolute
    })
    this.tempDirOption = options.tempDir
    this.writeSids = options.writeSids === undefined ? options.writeSid === undefined ? [] : [options.writeSid] : [...options.writeSids]
    this.writeSid = options.writeSid ?? this.writeSids[0]
    if (options.writeSids !== undefined && (options.writeSids.length !== this.writableDirs.length || new Set(options.writeSids).size !== options.writeSids.length)) {
      throw new Error('AclSandbox requires one distinct workspace write SID per writable directory')
    }
    if (options.writeSids !== undefined && options.writeSid !== undefined && options.writeSid !== options.writeSids[0]) {
      throw new Error('AclSandbox primary write SID must match the first workspace write SID')
    }
    this.tempWriteSid = options.tempWriteSid
    if (this.mode === 'workspace-write' && this.writeSid === undefined) {
      throw new Error('AclSandbox workspace-write requires a write SID — derive it from the workspace via workspaceWriteSid()')
    }
    if (this.mode === 'workspace-write' && this.tempDirOption === undefined) {
      throw new Error('AclSandbox workspace-write requires an explicit private temp directory or null')
    }
    if (this.mode === 'read-only' && this.tempDirOption !== undefined && this.tempDirOption !== null) {
      throw new Error('AclSandbox read-only does not accept a temp directory')
    }
    if (this.mode === 'read-only' && (this.writeSids.length > 0 || this.writeSid !== undefined || this.tempWriteSid !== undefined)) {
      throw new Error('AclSandbox read-only does not accept write SIDs')
    }
    if (this.mode === 'workspace-write' && this.tempDirOption !== null && this.tempWriteSid === undefined) {
      throw new Error('AclSandbox workspace-write with temp requires a temp write SID — derive it via tempWriteSid()')
    }
    if (this.tempDirOption === null && this.tempWriteSid !== undefined) {
      throw new Error('AclSandbox temp write SID requires a temp directory')
    }
    if (this.tempWriteSid !== undefined && this.writeSids.includes(this.tempWriteSid)) {
      throw new Error('AclSandbox workspace and temp write SIDs must be distinct')
    }
  }

  /** Resolved temp directory (available after init; null when temp grants are disabled). */
  get tempDir(): string | null | undefined {
    return this.tempDirResolved
  }

  /** Create the restricted token and apply the capability-SID grants. Idempotent-unsafe: once per instance. */
  init(): Promise<void> {
    if (this.initialization || this.closing) return Promise.reject(new Error('AclSandbox initialization already admitted or closing'))
    this.initializing = true
    this.initialization = this.initialize().finally(() => { this.initializing = false })
    return this.initialization
  }
  private async initialize(): Promise<void> {
    if (this.api !== undefined) throw new Error('AclSandbox is already initialized')
    const api = await win32()
    this.api = api
    const owned = this.initOwner = new NativeInitOwner(api)
    try {
      if (this.closing) throw new Error('AclSandbox closed during initialization')
      const currentToken = openCurrentProcessToken(api, owned)
      const parseSid = (sid: string): NativePtr => {
        const slot = owned.slot()
        return owned.output(slot, 'local', 'ConvertStringSidToSidW', () => api.convertStringSidToSidW(sid, slot))
      }
      for (const sid of this.writeSids) this.writeSidPtrs.push(parseSid(sid))
      this.writeSidPtr = this.writeSidPtrs[0]
      this.tempWriteSidPtr = this.tempWriteSid === undefined ? undefined : parseSid(this.tempWriteSid)

      const tempDir = this.mode === 'read-only' || this.tempDirOption === null ? null : this.tempDirOption
      /* v8 ignore next -- constructor validation requires workspace-write to supply
         an explicit temp directory or null; the other branches normalize to null. */
      if (tempDir === undefined) throw new Error('AclSandbox workspace-write temp directory was not resolved')
      if (tempDir !== null) {
        if (!existsSync(tempDir) || !statSync(tempDir).isDirectory()) {
          throw new Error(`AclSandbox temp dir does not exist or is not a directory: ${tempDir}`)
        }
        assertPrivateTempDisjoint(this.writableDirs, tempDir)
      }
      this.tempDirResolved = tempDir

      // manageDacls: false — the caller (the sandbox seam's grant) already
      // materialized the ACEs; this instance must neither add nor remove any.
      // When this instance owns the DACLs, writableDir ACEs are STANDING (the
      // per-workspace reuse cache — dispose() never revokes them, or the next
      // provision would re-propagate the whole tree) and the temp ACE is
      // REVOCABLE (dispose() removes it before the private directory is
      // deleted; the ambient temp root is never granted).
      if (this.manageDacls) {
        if (this.writeSidPtr !== undefined) {
          for (const [index, path] of this.writableDirs.entries()) {
            grantWrite(api, path, this.writeSidPtrs[index] ?? this.writeSidPtr, owned)
          }
          if (tempDir !== null && this.tempWriteSidPtr !== undefined) {
            // Record BEFORE granting: grantWrite can throw after a successful
            // apply (a LocalFree failure), and the fail-closed catch must still
            // revoke that path (revoking an ungranted path is a no-op merge).
            this.grantedPaths.push({ path: tempDir, sidPtr: this.tempWriteSidPtr })
            grantWrite(api, tempDir, this.tempWriteSidPtr, owned)
          }
        }
      }
      const logonSid = findLogonSid(api, currentToken, owned)
      this.logonSid = logonSidText(owned, logonSid)
      const worldSid = makeWellKnownSid(api, abi.WinWorldSid, owned)
      const writeSids = [...this.writeSidPtrs, this.tempWriteSidPtr].filter((sid): sid is NativePtr => sid !== undefined)
      const restrictedToken = createRestrictedToken(
        api, currentToken, logonSid, writeSids,
        { world: worldSid },
        this.mode, owned,
      )
      this.token = restrictedToken
      // Include a restricting SID in the default DACL for objects that use
      // the token's default security descriptor. Prefer the private temp SID
      // over the shared workspace capability. Creation still depends on the
      // parent object's DACL. An API may supply a different descriptor:
      // Node/libuv named stdio pipes can still deny a restricted grandchild's
      // write access, so this grant alone does not establish pipe support.
      setTokenDefaultDaclGrant(api, restrictedToken, this.tempWriteSidPtr ?? this.writeSidPtr ?? worldSid, owned)
      owned.release(currentToken, 'handle')
      this.ready = true
    } catch (error) {
      this.closing = true
      try { this.finalizeInitialization() } catch (cleanup) { throw new NativeInitializationFailure(error, cleanup, this) }
      throw error
    } finally { this.initializing = false }
  }

  /**
   * Spawn a process under the restricted token. Fails closed: throws on every
   * Win32 failure; the child is never created unrestricted. With
   * `stdio: 'inherit'` the child shares the caller's stdio directly and is
   * placed in a kill-on-close job (dies with the caller). Call dispose() only
   * after all children have exited — revoking grants under a live child
   * removes its remaining write allowance.
   * @param options - the program, argv/cwd, and stdio shape.
   * @returns the running child.
   */
  spawn(options: AclSandboxSpawnOptions & { stdio: 'inherit' }): Promise<AclSandboxChild>
  spawn(options: AclSandboxSpawnOptions & { stdio?: 'pipe' }): Promise<AclSandboxChild>
  spawn(options: AclSandboxSpawnOptions): Promise<AclSandboxChild>
  spawn(options: AclSandboxSpawnOptions): Promise<AclSandboxChild> {
    const api = this.api
    const token = this.token
    if (!this.ready || this.closing || api === undefined || token === undefined) throw new Error('AclSandbox is not initialized: call init() first')
    const args = [...(options.args ?? [])]
    const cwd = options.cwd ?? process.cwd()

    if (options.stdio === 'inherit') {
      buildCommandLine(options.command,args,options.argumentEncoding)
      return this.admitChild(createInheritedChildOwner(Object.freeze({command:options.command,args:Object.freeze(args),cwd,argumentEncoding:options.argumentEncoding,windowsHide:options.windowsHide}),{
        api,token,assertLaunchCurrent:()=>{if(this.api!==api||this.token!==token)throw new Error('AclSandbox original launch owner retired')},acquireWaitClient:()=>acquireWaitDrainBridgeClient(),
      }))
    }

    if (this.logonSid === undefined) throw new Error('AclSandbox logon SID unavailable')
    buildCommandLine(options.command, args, options.argumentEncoding)
    const record = createPipeChildOwner(Object.freeze({command:options.command, args:Object.freeze(args), cwd, argumentEncoding:options.argumentEncoding}), {
      api, token, logonSid:this.logonSid,
      // Closing fences new admission. Already admitted records retain the
      // original token/grants until disposal has joined them.
      assertLaunchCurrent: () => { if (this.api !== api || this.token !== token) throw new Error('AclSandbox original launch owner retired') },
      acquireWaitClient: () => acquireWaitDrainBridgeClient(),
    })
    return this.admitChild(record)
  }
  private admitChild(record: PipeChildOwner): Promise<AclSandboxChild> {
    this.pipeChildren.add(record) // Both stdio modes share original admission.
    const result = record.start()
    void result.then(child => child.wait(), () => record.joinCleanup()).finally(() => {
      if (!record.pending()) this.pipeChildren.delete(record)
    }).catch(() => {})
    return result
  }

  /**
   * Revoke the revocable (temp) grants, free the SID, close the token; the
   * standing workspace ACEs stay (the reuse cache). Reports every cleanup
   * failure.
   */
  dispose(): void {
    if (this.initializing || this.disposal || [...this.pipeChildren].some(child => child.pending())) throw new Error('AclSandbox work active: use disposeAsync()')
    this.closing = true
    this.finalizeInitialization()
  }
  disposeAsync(): Promise<void> {
    this.closing = true
    if (this.disposal) return this.disposal
    const attempt = (async () => {
      if (this.initialization) await this.initialization.catch(() => {})
      const children = [...this.pipeChildren]
      const results = await Promise.allSettled(children.map(child => child.joinCleanup()))
      for (const child of children) if (!child.pending()) this.pipeChildren.delete(child)
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'AclSandbox children retain cleanup debt')
      if (this.pipeChildren.size) throw new Error('AclSandbox children remain owned')
      this.finalizeInitialization()
    })()
    this.disposal = attempt
    void attempt.finally(() => { if (this.disposal === attempt) this.disposal = undefined }).catch(() => {})
    return attempt
  }
  private finalizeInitialization(): void {
    this.ready = false
    const api = this.api
    if (!api) return
    this.initOwner?.cleanupScopes()
    const failures: unknown[] = []
    const retained: typeof this.grantedPaths = []
    for (const grant of this.grantedPaths) {
      try { revokeWrite(api, grant.path, grant.sidPtr, this.initOwner) } catch (error) { failures.push(error); if (!(error instanceof NativeCleanupFailure && error.operationCompleted)) retained.push(grant) }
    }
    this.grantedPaths = retained
    if (failures.length) throw new AggregateError(failures, 'AclSandbox grant cleanup incomplete')
    this.initOwner?.cleanup()
    this.api = undefined
    this.token = undefined
    this.logonSid = undefined
    this.writeSidPtr = undefined
    this.writeSidPtrs = []
    this.tempWriteSidPtr = undefined
    this.tempDirResolved = undefined
  }

}

/**
 * The windows-acl deny dialect (case-insensitive stderr substrings a
 * denied file effect produces under it — carried on every wrap as the
 * seam's `ConfinedArgv.denialSignatures`).
 */
const DENIAL_SIGNATURES = ['access is denied', 'access to the path', 'permission denied']

/**
 * The windows-acl runner's documented failure exit (its own
 * RUNNER_FAILURE_EXIT contract, distinct from Landlock's 125).
 */
const WINDOWS_ACL_RUNNER_FAILURE_EXIT = 127

/**
 * The CHILD-side death this backend's restriction produces: an MSYS/Cygwin
 * program cannot create the named signal pipe its runtime starts with, so it
 * dies inside DLL initialization before the command body runs. Windows reports
 * STATUS_DLL_INIT_FAILED (0xC0000142); Node reads that back as the unsigned
 * 3221225794 (verified empirically on this host, Windows 11 26200: the real
 * provider's confined Git Bash 5.3.15 exits 3221225794 with
 * "*** fatal error - couldn't create signal pipe, Win32 error 5" on stderr and
 * nothing on stdout, while a confined native cmd.exe/node/git.exe exits 0). The
 * runner itself starts fine and mirrors that status, so the runner-owned rule
 * below never sees it.
 */
const WINDOWS_ACL_MSYS_INIT_FAILURE_EXIT = 3221225794

/**
 * The ways a confined command turns out NEVER to have run — the seam's
 * `runnerFailureRules`, which exec turns into SandboxUnavailableError instead of
 * an ordinary nonzero exit. Two dialects, each exit-gated so a confined command
 * that merely PRINTS a signature (or a runner cleanup failure reported on a
 * non-zero child exit) is never misclassified as "the command did not run":
 *
 *  - the RUNNER's own failure: it prints `windows-acl-run: <detail>` and exits
 *    127.
 *  - an MSYS/Cygwin CHILD that died in initialization under the token (the
 *    signal-pipe fatal above). Both the status AND the signature are required:
 *    a native command can die in DLL init for reasons the restriction did not
 *    cause — a missing dependency, say — and blaming the sandbox for those
 *    would send the model to a wider mode that cannot help it.
 */
const RUNNER_FAILURE_RULES = [
  { allowedExitCodes: [WINDOWS_ACL_RUNNER_FAILURE_EXIT], fatalSignatures: ['windows-acl-run: '] },
  { allowedExitCodes: [WINDOWS_ACL_MSYS_INIT_FAILURE_EXIT], fatalSignatures: ["couldn't create signal pipe"] },
]

/** The runner entry argv prefix. Source launch: the package source through
 * tsx. DIST (build-dist defines I_HARNESS_DIST): the sibling bundle entry
 * `<out>/runner.mjs`, emitted next to ih.mjs — the sandbox never needs a
 * source checkout or tsx there. */
function runnerInvocation(): string[] {
  if (process.env.I_HARNESS_DIST === '1') {
    return [process.execPath, fileURLToPath(new URL('./runner.mjs', import.meta.url))]
  }
  const sourceEntry = fileURLToPath(new URL('./runner.ts', import.meta.url))
  // The tsx loader is named by an ABSOLUTE file URL resolved from THIS module,
  // never the bare `tsx/esm` specifier: the confined child spawns with
  // cwd = the assembly workspace (D1), which may sit outside any node_modules
  // tree — a cwd-resolved bare specifier then dies with ERR_MODULE_NOT_FOUND
  // and the confined command never runs. Resolution here is deliberate: the
  // spawn cwd must stay the workspace, only the loader specifier changes.
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  return [process.execPath, '--import', loader, sourceEntry]
}

/**
 * One live session/project-root set's private temp directory and capability.
 */
interface AclTempCapability {
  dir: string
  writeSid: string
  grant: AclWriteGrant
}

/**
 * Create the Windows ACL sandbox backend as a {@link SandboxProvider}.
 *
 * The provider holds one standing workspace grant per workspace
 * ({@link AclWriteGrant}: the ACE is the cross-session reuse cache and is
 * deliberately never revoked) and one revocable private-temp grant per live
 * session/project-root set; `confine()` builds the runner invocation per call.
 * With a calling session (the policy's `sessionId`) under workspace-write,
 * the grants are materialized once per provider lifetime and the runner
 * receives one `--write-sid` per root plus `--temp-write-sid` and grants nothing itself
 * (`manageDacls: false`). Agentless workspace-write calls pass the ambient
 * temp ROOT and no SID flags: the runner creates and removes a random
 * private child directory for that one invocation. Read-only leaves the
 * ambient temp entries untouched (writes there are denied anyway).
 *
 * Fail-closed at every level: construction requires existing writable
 * directories; confinement fails closed by throwing (the seam contract at
 * {@link SandboxProvider} — the thrown error may be a
 * {@link SandboxUnavailableError}, a {@link Win32Error}, a generic Error (a
 * failed grant materialization), or the raw ENOENT from
 * `assertTempRootOutsideWorkspace`) — a child is NEVER spawned unrestricted.
 *
 * NOTE: only `writableDirs` is consumed by the factory (its existence is
 * validated at construction). `mode`, `tempDir`, `writeSid`, `writeSids`,
 * `tempWriteSid`, and `manageDacls` are NOT read here — they exist because
 * spec §5.1 mandates {@link AclSandboxOptions} as the construction type, and
 * the per-call `SandboxPolicy` (mode, workspaceRoot, sessionId) is the actual
 * enforcement input. A confinement's mode therefore comes from the policy,
 * never from the construction options.
 * @param options - the construction options; only `writableDirs` is
 *   consumed (validated to exist). The per-call policy governs confinement.
 * @returns the enclosing {@link SandboxProvider} (with a `dispose()` that
 *   revokes the provider's temp grants and removes its private temp dirs).
 */
export interface AclSandboxProvider extends SandboxProvider {
  confineExecution(argv: readonly string[], policy: SandboxPolicy, argumentEncoding: ProcessSpec['argumentEncoding']): ConfinedArgv
  dispose(): void
}
export function createWindowsAclSandbox(options: AclSandboxOptions & {
  /** Trusted existing root for runner metadata; this does not grant write authority. */
  privateTempRoot?: string
  /** Compose only the policy-declared workspace grants. No private temp grant or environment rewrite. */
  disablePrivateTempWrites?: boolean
  /** Trusted hidden-console composition only; does not change token, grants or console attachment. */
  hideChildWindows?: boolean
}): AclSandboxProvider {
  const hideChildWindows = options.hideChildWindows === true
  // Fail closed at composition: declared writable directories must exist.
  // (The per-policy write-SID derivation and grant materialization happen at
  // confine() — the AclSandbox class requires the SID at construction, so a
  // workspace-write provider cannot be fully constructed here.)
  for (const directory of options.writableDirs) {
    const absolute = resolve(directory)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`AclSandbox writable dir does not exist or is not a directory: ${absolute}`)
    }
  }
  if (options.privateTempRoot !== undefined && !isAbsolute(options.privateTempRoot)) {
    throw new Error('AclSandbox private temp root must be absolute')
  }
  const privateTempRoot = options.privateTempRoot === undefined ? tmpdir() : resolve(options.privateTempRoot)
  if (!existsSync(privateTempRoot) || !statSync(privateTempRoot).isDirectory()) {
    throw new Error(`AclSandbox private temp root does not exist or is not a directory: ${privateTempRoot}`)
  }
  const workspaceGrants = new Map<string, AclWriteGrant>()
  // A failed post-apply add is never a ready workspace capability. Keep its
  // native SID owner separately until explicit dispose can finish cleanup.
  const partialWorkspaceGrants = new Set<AclWriteGrant>()
  const tempCapabilities = new Map<string, AclTempCapability>()

  function materializeWorkspaceGrants(roots: string[]): void {
    for (const workspaceRoot of roots) {
      assertTempRootOutsideWorkspace(workspaceRoot, privateTempRoot)
      const writeSid = workspaceWriteSid(workspaceRoot)
      if (!workspaceGrants.has(workspaceRoot)) {
        const grant = AclWriteGrant.create(writeSid)
        try {
          grant.add(workspaceRoot, true)
        } catch (error) {
          // Free the SID; a standing ACE (if the apply succeeded before a
          // post-apply throw) is the intended end state, not an error
          // artifact — nothing to revoke.
          try {
            grant.dispose()
          } catch (cleanupError) {
            partialWorkspaceGrants.add(grant)
            closing = true
            throw new AggregateError([error, cleanupError], 'windows-acl workspace grant failed and its cleanup also failed')
          }
          throw error
        }
        workspaceGrants.set(workspaceRoot, grant)
      }
    }
  }
  function materializeAclGrant(sessionId: string, roots: string[]): AclTempCapability {
    materializeWorkspaceGrants(roots)
    // A new root set gets a new private capability as well. A token must never
    // retain a private-object SID from a prior, broader project scope.
    const key = JSON.stringify([sessionId, [...roots].sort()])
    const existing = tempCapabilities.get(key)
    if (existing !== undefined) return existing
    const tempDir = mkdtempSync(join(privateTempRoot, 'dsh-'))
    const tempSid = tempWriteSid(tempDir)
    let grant: AclWriteGrant | undefined
    try {
      grant = AclWriteGrant.create(tempSid)
      grant.add(tempDir)
    } catch (error) {
      const cleanupFailures: unknown[] = []
      if (grant !== undefined) {
        try {
          grant.dispose()
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'windows-acl temp grant materialization failed and its cleanup also failed')
      }
      throw error
    }
    const capability = { dir: tempDir, writeSid: tempSid, grant }
    tempCapabilities.set(key, capability)
    return capability
  }

  function revokeAclGrants(): void {
    if (workspaceGrants.size === 0 && partialWorkspaceGrants.size === 0 && tempCapabilities.size === 0) return
    const failures: unknown[] = []
    for (const grant of partialWorkspaceGrants) {
      try {
        grant.dispose()
        partialWorkspaceGrants.delete(grant)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const [root, grant] of workspaceGrants) {
      try {
        grant.dispose()
        workspaceGrants.delete(root)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const [key, capability] of tempCapabilities) {
      try {
        capability.grant.dispose()
        rmSync(capability.dir, { recursive: true, force: true })
        tempCapabilities.delete(key)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `windows-acl grant cleanup incomplete with ${failures.length} failure(s)`)
    }
  }

  /** Current policy roots only; cached grants for removed roots never enter this token. */
  function aclRunnerArgv(policy: SandboxPolicy): string[] {
    const sessionId = policy.sessionId
    const roots = workspaceRoots(policy)
    for (const root of roots) {
      if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`AclSandbox workspace is not an existing directory: ${root}`)
    }
    const rootArgs = roots.flatMap((root) => ['--workspace', root])
    if (options.disablePrivateTempWrites && policy.mode === 'workspace-write') {
      if (sessionId === undefined) throw new Error('workspace-write without private temp requires a trusted session ID')
      materializeWorkspaceGrants(roots)
      return [
        ...runnerInvocation(), ...rootArgs,
        '--temp', privateTempRoot, '--mode', policy.mode, '--no-temp-write', 'true',
        ...roots.flatMap((root) => ['--write-sid', workspaceWriteSid(root)]),
      ]
    }
    if (sessionId === undefined || policy.mode === 'read-only') {
      return [
        ...runnerInvocation(),
        ...rootArgs,
        '--temp', privateTempRoot,
        '--mode', policy.mode,
      ]
    }
    const temp = materializeAclGrant(sessionId, roots)
    return [
      ...runnerInvocation(),
      ...rootArgs,
      '--temp', temp.dir,
      '--mode', policy.mode,
      ...roots.flatMap((root) => ['--write-sid', workspaceWriteSid(root)]),
      '--temp-write-sid', temp.writeSid,
    ]
  }

  let disposed = false
  let closing = false
  function confineExecution(argv: readonly string[], policy: SandboxPolicy, argumentEncoding: ProcessSpec['argumentEncoding']): ConfinedArgv {
    if (closing) throw new SandboxUnavailableError(policy.mode, 'windows ACL backend is disposed or closing')
    if (argumentEncoding !== 'crt' && argumentEncoding !== 'cmd-verbatim') throw new Error('invalid argument encoding')
    if (argumentEncoding === 'cmd-verbatim') buildCommandLine(argv[0] ?? '', argv.slice(1), argumentEncoding)
    return {
      argv: [...aclRunnerArgv(policy), ...(hideChildWindows ? ['--windows-hide', 'true'] : []), ...(argumentEncoding === 'cmd-verbatim' ? ['--argument-encoding', argumentEncoding] : []), '--', ...argv],
      enforcement: 'partial',
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }
  return {
    confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv { return confineExecution(argv, policy, 'crt') },
    confineExecution,
    dispose(): void {
      if (disposed) return
      closing = true
      revokeAclGrants()
      disposed = true
    },
  }
}
