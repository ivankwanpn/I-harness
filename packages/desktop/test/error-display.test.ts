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
})

it('keeps task deadlines distinct from connection loss', () => {
 const result = displayError('SdkTimeoutError: Request "session/prompt" timed out after 100ms')
 expect(result.summary).toContain('仍可能在處理')
 expect(result.summary).not.toContain('連線已中斷')
})
