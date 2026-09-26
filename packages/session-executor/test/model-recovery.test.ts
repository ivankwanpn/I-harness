import { expect, it, vi } from "vitest"
import { createSessionService } from "../src/index.ts"
it("retries non-ready bindings after configuration changes but keeps ready bindings stable", async () => {
  let configured = false
  const resolve = vi.fn(async () => configured
    ? { status: "ready" as const, binding: { providerId: "p", modelId: "m", label: "ready", model: { async *stream() {} } } }
    : { status: "unconfigured" as const, reason: "missing key" })
  const service = createSessionService({ workspace: process.cwd(), modelBindingFor: resolve })
  try {
    expect(await service.modelState("s")).toMatchObject({ status: "unconfigured" })
    configured = true
    expect(await service.modelState("s")).toMatchObject({ status: "ready", modelId: "m" })
    expect(await service.modelState("s")).toMatchObject({ status: "ready", modelId: "m" })
    expect(resolve).toHaveBeenCalledTimes(2)
  } finally { await service.close() }
})
