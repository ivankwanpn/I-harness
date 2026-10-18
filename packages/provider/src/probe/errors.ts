/** No probe AND no static catalog for the route — probing is genuinely
 * unavailable (Task 4 maps this to the "model-probe-failed" 400 family). */
export class ProbeUnavailableError extends Error {
  readonly code = "probe-unavailable" as const
  readonly route: string
  constructor(route: string) {
    super(`no model probe available for route "${route}" (no probe registered, no static catalog)`)
    this.name = "ProbeUnavailableError"
    this.route = route
  }
}

/** Every in-flight probe failure is branded with this code — the symmetric
 * sibling of ProbeUnavailableError (Task 4 maps it to 400 model-probe-failed)
 * so a caller can tell "the probe exists but failed" from "no probe exists". */
export class ModelProbeFailedError extends Error {
  readonly code = "model-probe-failed" as const
  constructor(message: string) {
    super(message)
    this.name = "ModelProbeFailedError"
  }
}
