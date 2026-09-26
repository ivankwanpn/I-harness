import { describe, expect, it } from "vitest"
import { externalWebUrl } from "../src/main/external-url.ts"

describe("external web links", () => {
  it("accepts web references and local web previews", () => {
    expect(externalWebUrl("https://example.com/docs?q=one#section")).toBe("https://example.com/docs?q=one#section")
    expect(externalWebUrl("http://localhost:5173/")).toBe("http://localhost:5173/")
  })
  it("rejects files, executable protocols, credentials and invalid URLs", () => {
    for (const value of ["file:///C:/test", "javascript:alert(1)", "ms-settings:privacy", "data:text/html,test", "https://name:secret@example.com", "/relative"]) {
      expect(externalWebUrl(value)).toBeUndefined()
    }
  })
})
