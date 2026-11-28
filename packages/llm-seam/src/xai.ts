import type { ReasoningEffort } from "./index.ts"

const globalRoute = Object.freeze({ origin: "xai-api" as const, url: "https://api.x.ai" })
const usRoute = Object.freeze({ origin: "xai-us-api" as const, url: "https://us.api.x.ai" })

/** Match only documented HTTPS hosts and preserve the selected region. */
export function officialXaiRoute(baseUrl?: string) {
  const root = baseUrl?.replace(/\/(?:v1\/?)?$/, "")
  if (root === globalRoute.url) return globalRoute
  if (root === usRoute.url) return usRoute
}

const efforts: ReadonlyMap<string, readonly string[]> = new Map([
  ["grok-4.3", ["none", "low", "medium"]],
  ["grok-4.5", ["low", "medium", "high"]],
  ["grok-4.6", ["low", "medium", "high", "xhigh"]],
  ["grok-4.7", ["low", "medium", "high", "xhigh"]],
  ["grok-4.20-multi-agent", ["low", "medium", "high", "xhigh"]],
])

/** Map the harness maximum to the documented maximum on a known model. */
export function resolveXaiEffort(baseUrl: string | undefined, model: string, requested: ReasoningEffort | undefined, configured: unknown): ReasoningEffort | undefined {
  const allowed = officialXaiRoute(baseUrl) ? efforts.get(model) : undefined
  if (!allowed) return requested
  const maximum = allowed.at(-1) as ReasoningEffort
  const value = requested === "max" ? maximum : requested === "off" ? "none" : requested ?? configured
  if (typeof value === "string" && !allowed.includes(value)) {
    const message = `${model} supports reasoning efforts: ${allowed.join(", ")}.`
    throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT", modelFailure: { code: "INVALID_ARGUMENT", reason: "unsupported-parameter", message } })
  }
  return requested === "max" ? maximum : requested
}
