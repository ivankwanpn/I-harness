import { expect, it } from "vitest"
import { basename, dirname, resolve } from "node:path"
import { appendFileSync, copyFileSync, mkdtempSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { verifyHelper } from "../src/integrity.ts"
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

it("rejects an executable whose content differs from the pinned manifest", async () => {
  const source = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64")
  const fixture = mkdtempSync(resolve(repo, ".tmp", "sandbox-redesign-integrity-"))
  const manifestPath = resolve(fixture, "manifest.json")
  const helperPath = resolve(fixture, "i-harness-windows-helper.exe")
  copyFileSync(resolve(source, basename(helperPath)), helperPath)
  copyFileSync(resolve(source, "manifest.json"), manifestPath)
  appendFileSync(helperPath, Buffer.from([0]))
  await expect(verifyHelper({ helperPath, manifestPath })).rejects.toThrow(/hash mismatch/i)
})

it("requires manifest and helper in the same artifact directory", async () => {
  const fixture = mkdtempSync(resolve(repo, ".tmp", "sandbox-redesign-location-"))
  const manifestPath = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/manifest.json")
  const helperPath = resolve(fixture, "i-harness-windows-helper.exe")
  copyFileSync(resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe"), helperPath)
  await expect(verifyHelper({ helperPath, manifestPath })).rejects.toThrow(/location/i)
})
