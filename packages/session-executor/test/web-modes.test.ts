import { expect, it } from "vitest"
import { createSessionService } from "../src/index.ts"

it("captures web mode for the actual tool registry, changing defaults only for new assemblies", async () => {
  let mode: "disabled" | "cached" = "disabled"
  const service = createSessionService({workspace: process.cwd(), modelPolicy: "test-mock", webSearchModeFor: () => mode})
  try {
    const before = await service.assemblyFor("disabled-web")
    expect(before.tools.get("webfetch")).toBeUndefined()
    mode = "cached"
    const after = await service.assemblyFor("cached-web")
    expect(after.tools.get("webfetch")).toBeDefined()
    expect(before.tools.get("webfetch")).toBeUndefined()
    await expect(after.tools.execute({name: "webfetch", args: {url: "https://test.example/uncached"}})).rejects.toThrow("WEB_CACHE_MISS")
    expect(after.tools.get("websearch")).toBeUndefined()
  } finally { await service.close() }
})
