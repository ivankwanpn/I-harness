import { expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
// @ts-expect-error The packaging helper runs directly as native ESM JavaScript.
import { createPortableArchive } from "../scripts/portable-archive.mjs"

it.skipIf(process.platform !== "win32")("creates an Explorer-readable folder and preserves files when extracted", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-archive-"))
  try {
    const app = join(root, `a space and ' quote ${"x".repeat(80)}`, "I-harness")
    mkdirSync(join(app, "resources"), { recursive: true })
    writeFileSync(join(app, "I-harness.exe"), "MZtest payload")
    writeFileSync(join(app, "resources", "中文.txt"), "literal contents\n")
    const nested = ["a".repeat(80), "b".repeat(80)]
    mkdirSync(join(app, ...nested), { recursive: true })
    const longPath = join(app, ...nested, "long-filename.txt")
    expect(longPath.length).toBeGreaterThan(260)
    writeFileSync(longPath, "long path")
    const zip = join(root, "I-harness.zip")
    expect(createPortableArchive(app, zip)).toBeGreaterThan(0)
    const output = join(root, "extracted")
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "[System.AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling',$false)",
        "[System.AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths',$false)",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:IH_ARCHIVE_TEST_ZIP, $env:IH_ARCHIVE_TEST_OUTPUT)",
      ].join("; ")
    ], { env: { ...process.env, IH_ARCHIVE_TEST_ZIP: zip, IH_ARCHIVE_TEST_OUTPUT: output }, windowsHide: true, encoding: "utf8", timeout: 30_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(output, "I-harness", "I-harness.exe"), "utf8")).toBe("MZtest payload")
    expect(readFileSync(join(output, "I-harness", "resources", "中文.txt"), "utf8")).toBe("literal contents\n")
    expect(readFileSync(join(output, "I-harness", ...nested, "long-filename.txt"), "utf8")).toBe("long path")
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 45_000)
