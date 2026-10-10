import { join } from "node:path"
import { inspectWslRuntime, type WslDependencyStatus } from "@i-harness/sandbox-wsl"
import { captureCacheRoot, installManagedRelease, verifiedManagedRelease } from "./cache.ts"
import { NODE_PIN } from "./pin.ts"
interface WorkspaceRuntimeConfiguration { distribution: string; workspaceDependencies: boolean; networkAccess?: boolean }
interface ManagedRuntimeResolution {
  status: "available" | "missing" | "disabled" | "unavailable"
  detail: string
  path?: string
  runtimePath?: readonly string[]
  source?: "managed" | "system"
  nodeVersion?: string
}
interface RuntimeInspection {
  available: boolean; detail: string
  dependencies: Readonly<Record<string, WslDependencyStatus>>
  paths: readonly { windows: string; linux: string }[]
}
interface WorkspaceRuntimeOptions {
  cacheRoot: string
  fetch?: typeof fetch
  inspectRuntime?: (distribution: string, paths?: readonly string[]) => Promise<RuntimeInspection>
}
function capture(configuration: WorkspaceRuntimeConfiguration): Readonly<WorkspaceRuntimeConfiguration> {
  if (!configuration || typeof configuration.workspaceDependencies !== "boolean"
    || typeof configuration.distribution !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(configuration.distribution)
    || configuration.distribution.trim() !== configuration.distribution || configuration.networkAccess !== undefined && typeof configuration.networkAccess !== "boolean") throw new Error("Invalid captured workspace runtime configuration")
  return Object.freeze({ ...configuration })
}
const disabled = (): ManagedRuntimeResolution => ({ status: "disabled", detail: "Workspace dependencies are disabled; no managed runtime download or installation is allowed." })
export function createWorkspaceRuntime(options: WorkspaceRuntimeOptions) {
  const cacheRoot = captureCacheRoot(options.cacheRoot), fetcher = options.fetch ?? globalThis.fetch, inspect = options.inspectRuntime ?? inspectWslRuntime
  async function runtime(configuration: WorkspaceRuntimeConfiguration, paths: readonly string[] = []): Promise<RuntimeInspection | ManagedRuntimeResolution> {
    if (process.arch !== "x64") return { status: "unavailable", detail: "The pinned managed Linux runtime currently supports x64 hosts only." }
    let inspected: RuntimeInspection
    try { inspected = await inspect(configuration.distribution, paths) }
    catch (cause) { return { status: "unavailable", detail: `Selected WSL runtime inspection failed: ${cause instanceof Error ? cause.message : String(cause)}` } }
    const absent = ["python", "bash", "bubblewrap"].filter(key => inspected.dependencies[key]?.available !== true)
    if (!inspected.available || absent.length) return { status: "unavailable", detail: `${inspected.detail}. Install system Python3, Bash and bubblewrap manually in ${configuration.distribution}; IH does not run apt, sudo or change distribution configuration.` }
    return inspected
  }
  async function mapped(configuration: WorkspaceRuntimeConfiguration, release: string): Promise<ManagedRuntimeResolution> {
    const bin = join(release, "bin")
    const inspected = await runtime(configuration, [cacheRoot, release, bin])
    if ("status" in inspected) return inspected
    const path = inspected.paths.find(entry => entry.windows === bin)?.linux
    if (!path || !/^\/(?!\/)/.test(path) || /[:\x00-\x1f]/.test(path) || path.split("/").some(part => part === "." || part === "..")) return { status: "unavailable", detail: "Managed runtime Linux path mapping is unavailable." }
    return { status: "available", detail: `Verified IH-owned Linux Node ${NODE_PIN.version} and npm ${NODE_PIN.npmVersion}.`, path, runtimePath: Object.freeze([path]), source: "managed", nodeVersion: NODE_PIN.version }
  }
  async function diagnose(configuration: WorkspaceRuntimeConfiguration): Promise<ManagedRuntimeResolution> {
    const captured = capture(configuration)
    if (!captured.workspaceDependencies) return disabled()
    const inspected = await runtime(captured)
    if ("status" in inspected) return inspected
    let release: string | undefined
    try { release = verifiedManagedRelease(cacheRoot) }
    catch (cause) { return { status: "unavailable", detail: `Managed runtime integrity check failed: ${cause instanceof Error ? cause.message : String(cause)}. Use repair to create a verified replacement release.` } }
    if (release) return mapped(captured, release)
    if (inspected.dependencies.node?.available && inspected.dependencies.npm?.available) return { status: "available", detail: "System Node/npm are available on the Linux runtime PATH; no managed download is needed.", source: "system" }
    return { status: "missing", detail: `Linux Node/npm are missing. Enable workspace dependencies and repair to install pinned Node ${NODE_PIN.version} in the IH-owned cache.` }
  }
  async function repair(configuration: WorkspaceRuntimeConfiguration, installOptions?: { signal?: AbortSignal }): Promise<ManagedRuntimeResolution> {
    const captured = capture(configuration)
    if (!captured.workspaceDependencies) return disabled()
    installOptions?.signal?.throwIfAborted()
    const inspected = await runtime(captured)
    if ("status" in inspected) return inspected
    const release = await installManagedRelease(cacheRoot, fetcher, installOptions?.signal)
    return mapped(captured, release)
  }
  async function resolveRuntime(configuration: WorkspaceRuntimeConfiguration, resolveOptions?: { installIfMissing?: boolean; signal?: AbortSignal }): Promise<ManagedRuntimeResolution> {
    const captured = capture(configuration)
    resolveOptions?.signal?.throwIfAborted()
    const result = await diagnose(captured)
    return result.status === "missing" && resolveOptions?.installIfMissing ? repair(captured, resolveOptions) : result
  }
  return Object.freeze({ diagnose, repair, resolve: resolveRuntime })
}
