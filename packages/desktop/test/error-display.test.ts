import { describe, expect, it } from "vitest"
import { displayError } from "../src/renderer/design/error-display.ts"

describe("displayError", () => {
  it("lists the SDK connection wrapper as a product message", () => {
    const result = displayError("Error invoking remote method 'ih-desktop:request': RpcError: SdkConnectionError: [sdk-connection] sdk subprocess exited (code 1, signal null)")
    expect(result.summary).toContain("桌面服務連線已中斷")
    expect(result.detail).toContain("SdkConnectionError")
  })
  it("keeps a plain message unchanged", () => {
    expect(displayError("Model request failed.")).toEqual({ summary: "Model request failed." })
  })
  it("names recovery and permission failures", () => {
    expect(displayError("Writer dependency cleanup unresolved").summary).toContain("工作狀態需要恢復")
    expect(displayError("EACCES: permission denied").summary).toContain("權限")
  })
  it("uses the provider category ahead of an ambiguous transport wrapper", () => {
    const quota = displayError("Error invoking remote method 'ih-desktop:request': RpcError: HTTP 429", { code: "QUOTA" })
    expect(quota.summary).toContain("供應商額度不足")
    expect(quota.detail).toContain("HTTP 429")
    expect(displayError("unknown", { code: "RATE_LIMIT", english: true }).summary).toContain("rate limiting")
    expect(displayError("HTTP 404", { code: "INVALID_ARGUMENT", httpStatus: 404 }).summary).toContain("模型或 API 端點")
    expect(displayError("Error: session/model/set: Invalid model protocol").summary).toContain("重新選擇模型")
  })
})

it('keeps task deadlines distinct from connection loss', () => {
 const result = displayError('SdkTimeoutError: Request "session/prompt" timed out after 100ms')
 expect(result.summary).toContain('仍可能在處理')
 expect(result.summary).not.toContain('連線已中斷')
})
