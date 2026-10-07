import type { ProcessSpec } from "./execution.ts"

/** Detach the complete process request before admission or preparation awaits. */
export function snapshotProcessSpec(spec: ProcessSpec): ProcessSpec {
  return Object.freeze({
    argv: Object.freeze([...spec.argv]), cwd: spec.cwd,
    env: Object.freeze({ ...spec.env }), owner: Object.freeze({ ...spec.owner }),
    transport: spec.transport, lifetime: spec.lifetime, argumentEncoding: spec.argumentEncoding,
    ...(spec.pty === undefined ? {} : { pty: Object.freeze({ ...spec.pty }) }),
  })
}
