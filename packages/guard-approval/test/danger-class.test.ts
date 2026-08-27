import { describe, expect, it } from "vitest"
import { DEFAULT_DANGEROUS_COMMANDS } from "../src/index.ts"
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
  it("cmd del /f INSIDE workspace is dangerous (slash-flag not target)", () => {
    expect(classifyDanger(["cmd", "/c", "del", "/f", `${WS}/t.txt`], WS)).toBe("dangerous")
  })
  it("cmd rd /s /q INSIDE workspace is dangerous", () => {
    expect(classifyDanger(["cmd", "/c", "rd", "/s", "/q", `${WS}/build`], WS)).toBe("dangerous")
  })
  it("powershell without -Command scans rest (fail-closed)", () => {
    expect(classifyDanger(["powershell", "Remove-Item", "C:/system/x.txt", "-Recurse", "-Force"], WS)).toBe("extreme")
  })
  it("powershell without -Command in-workspace is dangerous", () => {
    expect(classifyDanger(["powershell", "Remove-Item", `${WS}/build`, "-Recurse", "-Force"], WS)).toBe("dangerous")
  })
  // M22 final-review F1 回歸：預設清單含混合大小寫 "Remove-Item"，而 basenamePath
  // 一律 lowercase——兩側未 normalize 時這兩例回傳 "none"（force-less 刪除 fail-open）。
  it("mixed-case Remove-Item (no force) → dangerous (default list case-insensitive)", () => {
    expect(
      classifyDanger(["Remove-Item", "C:/Users/x/f.txt"], WS, [...DEFAULT_DANGEROUS_COMMANDS]),
    ).toBe("dangerous")
  })
  it("mixed-case Remove-Item in-workspace (no force) → dangerous", () => {
    expect(
      classifyDanger(["Remove-Item", `${WS}/f.txt`], WS, [...DEFAULT_DANGEROUS_COMMANDS]),
    ).toBe("dangerous")
  })
})
