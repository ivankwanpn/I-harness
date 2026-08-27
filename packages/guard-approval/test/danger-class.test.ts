import { describe, expect, it } from "vitest"
import { classifyDanger } from "../src/danger-class.ts"

const WS = "C:/repo/work"

// 最終簽名：classifyDanger(argv, workspace, dangerousCommands?, dangerousFlags?)
describe("classifyDanger", () => {
  it("extreme: rm -rf outside workspace", () => {
    expect(classifyDanger(["rm", "-rf", "C:/system"], WS)).toBe("extreme")
  })
  it("extreme: rm -rf / (root)", () => {
    expect(classifyDanger(["rm", "-rf", "/"], WS)).toBe("extreme")
  })
  it("extreme: Remove-Item -Recurse -Force outside", () => {
    expect(classifyDanger(["pwsh", "-Command", "Remove-Item C:\\system -Recurse -Force"], WS)).toBe("extreme")
  })
  it("extreme: cmd del /f outside", () => {
    expect(classifyDanger(["cmd", "/c", "del", "/f", "C:\\system\\x.txt"], WS)).toBe("extreme")
  })
  it("extreme: rm -rf INSIDE workspace is dangerous (not extreme)", () => {
    expect(classifyDanger(["rm", "-rf", `${WS}/build`], WS)).toBe("dangerous")
  })
  it("extreme: format", () => {
    expect(classifyDanger(["format", "C:", "/q"], WS)).toBe("extreme")
  })
  it("extreme: diskpart", () => {
    expect(classifyDanger(["diskpart", "/s", "script.txt"], WS)).toBe("extreme")
  })
  it("extreme: reg delete", () => {
    expect(classifyDanger(["reg", "delete", "HKLM\\SOFTWARE\\X", "/f"], WS)).toBe("extreme")
  })
  it("extreme: startup URL (phishing)", () => {
    expect(classifyDanger(["Start-Process", "https://evil.example"], WS)).toBe("extreme")
  })
  it("none: benign rm (no force)", () => {
    expect(classifyDanger(["rm", "file.txt"], WS)).toBe("none")
  })
  it("dangerous: metachar", () => {
    expect(classifyDanger(["bash", "-c", "echo hi; rm file"], WS)).toBe("dangerous")
  })
  it("dangerous: custom dangerousCommands still works", () => {
    expect(classifyDanger(["myrm", "-x"], WS, ["myrm"])).toBe("dangerous")
  })
})
