import { existsSync } from "node:fs"
import { isAbsolute, resolve, win32 } from "node:path"
import type { BackendRequirements, CompiledSandboxPolicy, ExecutionOwner, ProcessSpec } from "@i-harness/sandbox"
import { SandboxUnavailableError, snapshotProcessSpec } from "@i-harness/sandbox"
import { currentExecCaller } from "./caller-scope.ts"
import { ExecutionAdmissionError } from "./execution-admission.ts"
import type { ExecutionSupervisor, SupervisedExecution } from "./execution-supervisor.ts"
import { resolveWindowsMsysPty } from "./windows-msys-pty.ts"
import type { ExecExecutionHost, ExecServiceOptions, ExecTransportRequest } from "./index.ts"

function boundEnvironment(input?: Readonly<Record<string, string>>, target: "host" | "wsl" = "host"): Readonly<Record<string, string>> {
  const source = input === undefined ? target === "wsl" ? { PATH: "/usr/bin:/bin", LANG: "C" } : process.env : input
  const environment: Record<string, string> = {}
  if (process.platform === "win32" && target !== "wsl") {
    const keys = new Map<string, string>()
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      const previous = keys.get(key.toLowerCase())
      if (previous !== undefined) delete environment[previous]
      keys.set(key.toLowerCase(), key)
      environment[key] = value
    }
  } else for (const [key, value] of Object.entries(source)) if (value !== undefined) environment[key] = value
  return Object.freeze(environment)
}

function resolveExecutable(argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>): readonly string[] {
  if (process.platform !== "win32" || !argv[0] || isAbsolute(argv[0])) return argv
  const name = argv[0]
  const key = Object.keys(env).find(item => item.toLowerCase() === "path")
  const path = key === undefined ? "" : env[key]!
  const candidates = /[\\/]/.test(name) ? [resolve(cwd, name)]
    : path.split(";").filter(Boolean).map(directory => win32.resolve(directory.replace(/^"|"$/g, ""), name))
  const extensions = win32.extname(name) ? [""] : [".exe", ".com", ".cmd", ".bat"]
  for (const candidate of candidates) for (const extension of extensions) {
    const target = candidate + extension
    if (existsSync(target)) return [target, ...argv.slice(1)]
  }
  return argv
}

function requirements(policy: CompiledSandboxPolicy, request: ExecTransportRequest): BackendRequirements {
  return Object.freeze({
    writeIsolation: policy.mode !== "danger-full-access", readIsolation: request.sandbox?.requireReadIsolation === true,
    denyPaths: false, referenceProtection: policy.referenceRoots.length > 0, transport: request.transport, lifetime: request.lifetime,
    minimumAssurance: "unverified" as const,
  })
}

export function createTransportLaunch(options: ExecServiceOptions, host: ExecExecutionHost, supervisor: ExecutionSupervisor, isDisposed: () => boolean) {
  function caller(): Readonly<ExecutionOwner> {
    const owner = currentExecCaller() ?? host.defaultOwner
    if (!owner?.sessionId) throw new Error("Execution caller scope is missing")
    return Object.freeze({ sessionId: owner.sessionId, ...(owner.parentSessionId === undefined ? {} : { parentSessionId: owner.parentSessionId }) })
  }
  function canAccess(owner: Readonly<ExecutionOwner>): boolean {
    const actual = caller()
    return actual.sessionId === owner.sessionId || host.canAccessOwner?.(actual, owner) === true
  }

  function launchTransport(request: ExecTransportRequest, automaticPromotion = false): Promise<SupervisedExecution> {
    try {
      if (isDisposed()) throw new Error("Exec service disposed")
      const owner = caller()
      const policy = host.resolvePolicy(owner, request.sandbox)
      if (automaticPromotion && host.autoPromotionLifetime) request = { ...request, lifetime: host.autoPromotionLifetime(policy) }
      const cwd = resolve(request.cwd ?? options.workspaceRoot ?? process.cwd())
      const target = request.executionTarget ?? "host"
      if (target !== "host" && target !== "wsl") throw new Error("Invalid trusted execution target")
      const env = boundEnvironment(request.env, target)
      const processRequest: ProcessSpec = {
        ...(request.executionTarget === undefined ? {} : { executionTarget: target }),
        argv: target === "wsl" ? request.argv : resolveExecutable(request.argv, cwd, env), cwd,
        env, owner, transport: request.transport,
        lifetime: request.lifetime, argumentEncoding: request.argumentEncoding,
        ...(request.pty === undefined ? {} : { pty: request.pty }),
      }
      const spec = snapshotProcessSpec(policy.mode === "danger-full-access" ? resolveWindowsMsysPty(processRequest) : processRequest)
      let backend: ReturnType<ExecExecutionHost["selectBackend"]>
      try { backend = host.selectBackend(policy, spec.transport, spec) }
      catch (cause) {
        if (policy.mode !== "danger-full-access") throw new SandboxUnavailableError(policy.mode, cause instanceof Error ? cause.message : String(cause))
        throw cause
      }
      return supervisor.launch({ backend, spec, policy, requirements: requirements(policy, request),
        validateAuthority: current => host.validateAuthority(current), signal: request.abortSignal }).catch(cause => {
          if (policy.mode !== "danger-full-access" && cause instanceof ExecutionAdmissionError) {
            throw new SandboxUnavailableError(policy.mode, cause.message)
          }
          throw cause
        })
    } catch (cause) { return Promise.reject(cause) }
  }

  return { launchTransport, canAccess }
}
