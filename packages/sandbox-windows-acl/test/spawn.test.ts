import { describe, expect, it } from "vitest"
import { buildCommandLine, quoteArg, spawnSandboxedInherited } from "../src/spawn.ts"
import type { NativePtr, Win32Bindings } from "../src/ffi.ts"
import { Win32Error } from "../src/errors.ts"
import { STARTUPINFOW } from "../src/ffi.ts"
import koffi from "koffi"

describe("quoteArg (Windows argv quoting)", () => {
  it("quotes empty args", () => {
    expect(quoteArg("")).toBe('""')
  })

  it("does not quote a plain non-whitespace arg", () => {
    expect(quoteArg("hello")).toBe("hello")
  })

  it("quotes args with spaces + backslashes before a quote", () => {
    expect(quoteArg("C:\\path with spaces\\file.txt")).toBe('"C:\\path with spaces\\file.txt"')
  })

  // buildCommandLine is imported for the same quoteArg surface: it joins the
  // program and args through quoteArg into the single command-line string
  // CreateProcess parses.
  it("joins program and args through quoteArg", () => {
    expect(buildCommandLine("C:\\bin\\tool.exe", ["plain", "with space"])).toBe(
      'C:\\bin\\tool.exe plain "with space"',
    )
  })
  it("preserves the fifth CMD argument as one raw command line tail", () => {
    expect(buildCommandLine("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", 'echo "雪 空" > "out file.txt"'], "cmd-verbatim"))
      .toBe('C:\\Windows\\System32\\cmd.exe /d /s /c echo "雪 空" > "out file.txt"')
    expect(buildCommandLine("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", ""], "cmd-verbatim"))
      .toBe("C:\\Windows\\System32\\cmd.exe /d /s /c ")
  })
  it("refuses cmd-verbatim outside the exact cmd.exe /d /s /c raw-tail shape", () => {
    expect(() => buildCommandLine("C:\\bin\\tool.exe", ["/d", "/s", "/c", "echo x"], "cmd-verbatim")).toThrow(/cmd-verbatim/)
    expect(() => buildCommandLine("C:\\Windows\\System32\\cmd.exe", ["/c", "echo x"], "cmd-verbatim")).toThrow(/cmd-verbatim/)
    expect(() => buildCommandLine("C:/Windows/System32/cmd.exe", ["/d", "/s", "/c", "echo x"], "cmd-verbatim")).toThrow(/cmd-verbatim/)
  })
})

describe("spawnSandboxedInherited startup failure", () => {
  it.each([false, true])("preserves native error and inherited-console startup for windowsHide=%s", (windowsHide) => {
    let lastError = 0
    let startup: { dwFlags: number; wShowWindow: number; hStdInput: unknown } | undefined
    let creationFlags: unknown
    const api = {
      createJobObjectW: () => 100n,
      setInformationJobObject: () => 1,
      getStdHandle: () => 200n,
      setHandleInformation: (_handle: unknown, _mask: number, flags: number) => {
        if (flags === 0) lastError = 6
        return 1
      },
      createProcessAsUserW: (...args: unknown[]) => { startup = koffi.decode(args[9], STARTUPINFOW); creationFlags = args[6]; lastError = 2; return 0 },
      getLastError: () => lastError,
      closeHandle: () => { lastError = 6; return 1 },
      formatMessageW: () => 0,
    } as unknown as Win32Bindings

    let failure: unknown
    try {
      spawnSandboxedInherited(api, 300n as NativePtr, { command: "missing.exe", args: [], cwd: "C:\\owned", windowsHide })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Win32Error)
    expect(failure).toMatchObject({ api: "CreateProcessAsUserW", win32Code: 2 })
    expect(creationFlags).toBe(0x00000004) // CREATE_SUSPENDED remains the only creation flag.
    expect(startup).toMatchObject({ dwFlags: 0x100 | (windowsHide ? 1 : 0), wShowWindow: 0 })
  })
})
