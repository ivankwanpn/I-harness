import { win32 } from "node:path"
import type { ExecutionFileIdentity, MsysPtyBinding, ProcessSpec } from "./execution.ts"

function invalid(detail: string): never { throw new Error(`Invalid MSYS PTY binding: ${detail}`) }
function localPath(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z]:[\\/]/.test(value) || value.includes("\0") || value.includes(":", 2)) invalid("path must be absolute and local")
  return value
}
function identity(value: Readonly<ExecutionFileIdentity> | undefined): Readonly<ExecutionFileIdentity> {
  const path = localPath(value?.path)
  if (typeof value?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) invalid("invalid SHA-256")
  return Object.freeze({ path, sha256: value.sha256 })
}
function msysBinding(spec: ProcessSpec): Readonly<MsysPtyBinding> {
  if (spec.transport !== "pty" || spec.argumentEncoding !== "crt" || spec.executionTarget !== undefined && spec.executionTarget !== "host") invalid("requires host PTY with CRT arguments")
  const source = spec.msysPty!
  const executable = identity(source.executable), runtime = identity(source.runtime)
  if (win32.normalize(executable.path).toLowerCase() !== win32.normalize(spec.argv[0] ?? "").toLowerCase()) invalid("executable differs from argv[0]")
  if (source.resolution === undefined) return Object.freeze({ executable, runtime })
  if (source.resolution.kind !== "git-bash-shim") invalid("unknown resolution")
  const configuration = source.resolution.configuration
  const path = localPath(configuration?.path)
  if (configuration?.sha256 !== null && (typeof configuration?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(configuration.sha256))) invalid("configuration must record SHA-256 or absence")
  return Object.freeze({ executable, runtime, resolution: Object.freeze({ kind: "git-bash-shim", original: identity(source.resolution.original),
    configuration: Object.freeze({ path, sha256: configuration.sha256 }),
  }) })
}

/** Detach the complete process request before admission or preparation awaits. */
export function snapshotProcessSpec(spec: ProcessSpec): ProcessSpec {
  return Object.freeze({
    ...(spec.executionTarget === undefined ? {} : { executionTarget: spec.executionTarget }),
    argv: Object.freeze([...spec.argv]), cwd: spec.cwd,
    env: Object.freeze({ ...spec.env }), owner: Object.freeze({ ...spec.owner }),
    transport: spec.transport, lifetime: spec.lifetime, argumentEncoding: spec.argumentEncoding,
    ...(spec.pty === undefined ? {} : { pty: Object.freeze({ ...spec.pty }) }),
    ...(spec.msysPty === undefined ? {} : { msysPty: msysBinding(spec) }),
  })
}
