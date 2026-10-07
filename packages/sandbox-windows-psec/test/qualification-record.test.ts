import { describe, expect, expectTypeOf, it } from "vitest"
import { release as osRelease } from "node:os"
import { readWindowsQualification, type WindowsExecutionOptions } from "../src/index.ts"

expectTypeOf<Parameters<typeof readWindowsQualification>[0]>().toEqualTypeOf<WindowsExecutionOptions | undefined>()

describe.skipIf(process.platform !== "win32")("shipped Windows qualification record", () => {
  it("ties the incomplete outcome to this helper, protocol and Windows release", async () => {
    const view = await readWindowsQualification()
    expect(view.applicability).toBe("matching-host")
    expect(view.record.windowsRelease).toBe(osRelease())
    expect(view.record.result).toBe("incomplete")
    expect(view.record.assurance).toBe("experimental")
    expect(view.record.observed).toEqual({ passed: 38, failed: 0, unsupported: 4 })
    expect(view.record.sourceFamilies.gitMsysBash.psec).toBe("unsupported")
    expect(view.record.sourceFamilies.gitMsysBash.unrestricted).toBe("observed-pass")
    expect(Object.isFrozen(view.record)).toBe(true)
    expect(Object.isFrozen(view.record.sourceFamilies.gitMsysBash)).toBe(true)
  })

  it("does not apply the record to an unavailable helper", async () => {
    const view = await readWindowsQualification({ helperPath: "C:\\no-such-helper\\i-harness-windows-helper.exe" })
    expect(view.applicability).toBe("unavailable")
    expect(view.detail).toMatch(/location|ENOENT|helper/i)
  })
})
