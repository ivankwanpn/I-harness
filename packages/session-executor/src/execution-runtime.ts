import { AsyncLocalStorage } from "node:async_hooks"
import { tmpdir } from "node:os"
import { relative, isAbsolute, sep } from "node:path"
import { createExecutionSupervisor, currentExecCaller, withExecCallerScope, type ExecExecutionHost, type ExecutionReconciliationContext, type ExecutionReconciler } from "@i-harness/exec"
import { createLocalExecutionBackends, readWindowsQualification, type LocalExecutionBackends, type LocalExecutionOptions } from "@i-harness/sandbox-local"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { snapshotProcessSpec, type AuthorityState, type CompiledSandboxPolicy, type ExecutionOwner, type SandboxMode, type SandboxExecutionPolicy } from "@i-harness/sandbox"

export interface ExecutionRuntimeOptions {
  owner: ExecutionOwner
  ownerAvailable?(): boolean
  authority(): AuthorityState
  standing(): { mode: SandboxMode; generation: string }
  windowsSandboxBackend?: "legacy" | "psec" | "wsl"
  wslExecution?: LocalExecutionOptions["wslExecution"]
  legacyPrivateTempRoot?: string
}
const rank = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 }
function contains(root: string, path: string): boolean {
  const tail = relative(root, path)
  return tail === "" || !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`)
}

/** Assembly-owned authority and backend composition. No process operation lives here. */
export function createAssemblyExecutionRuntime(options: ExecutionRuntimeOptions) {
  const configured = options.windowsSandboxBackend ?? process.env.IH_WINDOWS_SANDBOX ?? "legacy"
  if (configured !== "legacy" && configured !== "psec" && configured !== "wsl") throw new Error("IH_WINDOWS_SANDBOX requires legacy, psec or wsl")
  const selected: "legacy" | "psec" | "wsl" = configured
  const wslExecution = Object.freeze({ distribution: options.wslExecution?.distribution ?? "Ubuntu", networkAccess: options.wslExecution?.networkAccess ?? false,
    workspaceDependencies: options.wslExecution?.workspaceDependencies ?? true,
    ...(options.wslExecution?.runtimePath === undefined ? {} : { runtimePath: Object.freeze([...options.wslExecution.runtimePath]) }) })
  const supervisor = createExecutionSupervisor()
  const backendOptions: LocalExecutionOptions = { windowsSelection: selected, wslExecution,
    // A location for the legacy protocol only: no private temp grants or environment rewriting.
    legacyPrivateTempRoot: options.legacyPrivateTempRoot ?? tmpdir() }
  const backends: LocalExecutionBackends = createLocalExecutionBackends(backendOptions)
  const callers = new AsyncLocalStorage<{ validate(): boolean }>()
  const owners = new Set<string>([options.owner.sessionId])
  const parents = new Map<string, string>()
  const blockedOwners = new Set<string>()
  const reconciliations = new Map<string, { generation: number; pending: number; successfulGeneration?: number }>()
  const captures = new WeakMap<CompiledSandboxPolicy, { generation: string; mode: SandboxMode; validate(): boolean }>()
  const grants = new WeakMap<object, { policy: CompiledSandboxPolicy; generation: string; mode: SandboxMode; validate(): boolean }>()
  const writes = new Set<{ policy: CompiledSandboxPolicy; abort(): void; done: Promise<void> }>()
  let disposed = false

  const validate: ExecutionReconciler & ((policy: CompiledSandboxPolicy) => void) = (policy: CompiledSandboxPolicy, context: ExecutionReconciliationContext = { phase: "preparing" }): void => {
    const captured = captures.get(policy)
    if (disposed || options.ownerAvailable?.() === false || !captured || !captured.validate()) throw new Error("Execution caller authority unavailable or revoked")
    const standing = options.standing()
    const current = compileExecutionPolicy({ mode: policy.mode, owner: policy.owner, authority: options.authority() })
    if (context.phase === "preparing") {
      if (captured.generation !== standing.generation || captured.mode !== standing.mode) throw new Error("Execution base grant generation changed")
      assertExecutionAuthority(policy, current)
    } else {
      if (rank[standing.mode] < rank[captured.mode]
        || policy.authorityKind !== current.authorityKind
        || policy.authorityRoots.some(root => !current.authorityRoots.some(next => contains(next, root)))
        || current.referenceRoots.some(root => !policy.referenceRoots.some(before => contains(before, root)))) {
        throw new Error("Execution authority narrowed")
      }
    }
  }
  const execution: ExecExecutionHost = {
    supervisor, defaultOwner: Object.freeze({ ...options.owner }),
    selectBackend: (policy, transport, spec) => backends.select(policy, transport, spec),
    resolvePolicy(owner, requested) {
      if (disposed) throw new Error("Execution runtime disposed")
      if (blockedOwners.has(owner.sessionId)) throw new Error("Execution owner admission blocked by reconciliation")
      const caller = callers.getStore()
      if (!caller && owner.sessionId !== options.owner.sessionId) throw new Error("Execution caller is unavailable")
      const grant = requested?.authoritySnapshot === undefined ? undefined : grants.get(requested.authoritySnapshot)
      if (requested?.authoritySnapshot && !grant) throw new Error("Unknown execution base authority token")
      if (grant && (grant.policy.owner.sessionId !== owner.sessionId || grant.policy.owner.parentSessionId !== owner.parentSessionId)) throw new Error("Execution grant belongs to another caller")
      const standing = grant ?? { ...options.standing(), validate: caller?.validate ?? (() => true) }
      const authority: AuthorityState = !grant ? options.authority() : grant.policy.authorityKind === "bound"
        ? { kind: "bound", revision: grant.policy.authorityRevision, primaryRoot: grant.policy.primaryRoot, roots: grant.policy.authorityRoots, references: grant.policy.referenceRoots }
        : { kind: "unbound", revision: grant.policy.authorityRevision, workspaceRoot: grant.policy.primaryRoot, references: grant.policy.referenceRoots }
      const policy = compileExecutionPolicy({ mode: requested?.mode ?? standing.mode, owner, authority })
      captures.set(policy, standing)
      owners.add(owner.sessionId)
      validate(policy)
      return policy
    },
    validateAuthority: validate,
    autoPromotionLifetime: policy => process.platform === "win32" && (selected === "legacy" || selected === "wsl" && policy.referenceRoots.length === 0)
      && policy.mode !== "danger-full-access" ? "complete-tree" : "retain-tree",
    canAccessOwner(caller, target) {
      const visited = new Set<string>()
      let parent = parents.get(target.sessionId)
      while (parent && !visited.has(parent)) {
        if (parent === caller.sessionId) return true
        visited.add(parent); parent = parents.get(parent)
      }
      return false
    },
    async dispose() {
      disposed = true
      for (const write of writes) write.abort()
      await Promise.all([...writes].map(write => write.done))
      await backends.dispose()
    },
  }
  return {
    windowsSandboxBackend: selected,
    wslExecution,
    execution,
    trackWrite<T>(abort: () => void, call: () => Promise<T>): Promise<T> {
      const policy = execution.resolvePolicy(currentExecCaller() ?? options.owner, undefined)
      let finish!: () => void
      const entry = { policy, abort, done: new Promise<void>(resolve => { finish = resolve }) }
      writes.add(entry)
      let pending: Promise<T>
      try { pending = call() } catch (error) { writes.delete(entry); finish(); throw error }
      return pending.finally(() => { writes.delete(entry); finish() })
    },
    validateGrant(token: object, mode: SandboxMode): void {
      execution.resolvePolicy(currentExecCaller() ?? options.owner, { mode, workspaceRoot: "", authoritySnapshot: token })
    },
    bindPolicy(policy: SandboxExecutionPolicy): SandboxExecutionPolicy {
      const token = Object.freeze({})
      const owner = currentExecCaller() ?? options.owner
      const standing = options.standing()
      const compiled = compileExecutionPolicy({ mode: standing.mode, owner, authority: options.authority() })
      grants.set(token, { policy: compiled, ...standing, validate: callers.getStore()?.validate ?? (() => true) })
      return { ...policy, authoritySnapshot: token }
    },
    withCaller<T>(owner: ExecutionOwner, validate: () => boolean, call: () => T): T {
      if (disposed || options.ownerAvailable?.() === false || !validate()) throw new Error("Execution caller authority unavailable")
      owners.add(owner.sessionId)
      if (owner.parentSessionId) parents.set(owner.sessionId, owner.parentSessionId)
      return callers.run({ validate }, () => withExecCallerScope(owner, call))
    },
    reconcile(): Promise<void> {
      // Each call synchronously fences all observed owners before any await.
      const attempts = [...owners].map(owner => {
        blockedOwners.add(owner)
        let state = reconciliations.get(owner)
        if (!state) { state = { generation: 0, pending: 0 }; reconciliations.set(owner, state) }
        const attempt = state
        const generation = ++attempt.generation
        attempt.pending++
        const pending: Promise<void>[] = [supervisor.reconcile(owner, validate)]
        for (const write of writes) {
          if (write.policy.owner.sessionId !== owner) continue
          try { validate(write.policy, { phase: "active" }) }
          catch { write.abort(); pending.push(write.done) }
        }
        return Promise.all(pending).then(() => {
          // An older success cannot retire a newer narrowing/failure fence.
          if (attempt.generation === generation && !disposed && options.ownerAvailable?.() !== false) attempt.successfulGeneration = generation
        }).finally(() => {
          attempt.pending--
          // Even the current successful attempt cannot reopen while an older
          // reconciliation still owns cleanup. Its completion only releases the
          // pending count; the current generation's success remains required.
          if (attempt.pending === 0 && attempt.successfulGeneration === attempt.generation
            && !disposed && options.ownerAvailable?.() !== false) blockedOwners.delete(owner)
        })
      })
      return Promise.all(attempts).then(() => {})
    },
    async status() {
      const authority = options.authority()
      // Revocation is an observed session state, not a failed settings read.
      // Do not compile a grant or probe a backend for an unavailable owner.
      if (authority.kind === "revoked" || authority.kind === "unavailable") return {
        authority: authority.kind, windowsSandboxBackend: selected, wslExecution, availability: "unavailable" as const,
        detail: `Execution authority ${authority.kind}: ${authority.reason}`,
        activeExecutions: supervisor.list().map(execution => execution.handle.receipt),
      }
      const policy = compileExecutionPolicy({ mode: options.standing().mode, owner: options.owner, authority })
      const spec = selected === "wsl" ? snapshotProcessSpec({ executionTarget: "wsl", argv: ["/bin/bash", "--version"], cwd: policy.primaryRoot,
        env: { PATH: [...(wslExecution.runtimePath ?? []), "/usr/bin", "/bin"].join(":"), LANG: "C" }, owner: policy.owner,
        transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" }) : undefined
      const probe = await backends.select(policy, "pipe", spec).probe()
      const nativeBackend = selected === "wsl" ? await backends.select(policy, "pipe").probe() : undefined
      const qualification = process.platform === "win32" ? await readWindowsQualification() : undefined
      return { windowsSandboxBackend: selected, wslExecution, ...probe, ...(nativeBackend ? { nativeBackend } : {}), qualification, activeExecutions: supervisor.list().map(execution => execution.handle.receipt),
        limits: probe.id === "windows-acl-legacy" ? "Root-bound complete-tree; no PTY, retained descendants or private writable temp. PowerShell may use ConstrainedLanguage."
          : selected === "wsl" ? "Linux Bash pipes and root-bound complete-tree background jobs; no WSL PTY or retained descendants. Native tools use a separate Windows backend."
          : "Qualification is historical evidence from one host; matching OS/artifacts do not establish current security or promote an experimental backend." }
    },
  }
}
