import { expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

// This export gate deliberately reads Git's index bytes, not a filesystem copy
// that can retain local CRLF. Stage the candidate before running this gate.
it.skipIf(process.platform !== "win32")("verifies and probes the exact Git-byte package in a fresh copy", () => {
  const root = resolve(import.meta.dirname, ".."), host = resolve(root, "../..")
  mkdirSync(resolve(host, ".tmp"), { recursive: true })
  const fixture = mkdtempSync(resolve(host, ".tmp/git-byte-package-"))
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", host, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    expect(result.status, result.stderr.toString()).toBe(0)
    return result.stdout
  }
  const names = git(["ls-files", "-z", "--", "packages/sandbox-windows-psec"]).toString().split("\0").filter(Boolean)
  for (const name of names) {
    const path = resolve(fixture, name); mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, git(["show", `:${name}`]))
  }
  const copy = resolve(fixture, "packages/sandbox-windows-psec")
  const manifest = JSON.parse(readFileSync(resolve(copy, "artifacts/win32-x64/manifest.json"), "utf8"))
  const pinned = ["protocol.md", "qualification.json", ...Object.keys(manifest.sources),
    "artifacts/win32-x64/manifest.json", "artifacts/win32-x64/i-harness-windows-helper.exe",
    "artifacts/win32-x64/i-harness-msys-pty.exe", ...Object.keys(manifest.msysPty.notices).map(name => `artifacts/win32-x64/${name}`)]
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
  const identities = pinned.map(name => ({ name, gitBytesSha256: sha(resolve(copy, name)), workingBytesSha256: sha(resolve(root, name)) }))
  writeFileSync(resolve(fixture, "exact-pinned-bytes.json"), JSON.stringify(identities, null, 2))
  for (const item of identities) expect(item.gitBytesSha256, item.name).toBe(item.workingBytesSha256)
  const entry = resolve(fixture, "verify-and-probe.mts")
  writeFileSync(entry, `import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {verifyNativeAssets} from ${JSON.stringify(pathToFileURL(resolve(host, "scripts/runtime-native-assets.mjs")).href)};
import {verifyHelper} from ${JSON.stringify(pathToFileURL(resolve(copy, "src/integrity.ts")).href)};
const manifest=verifyNativeAssets(${JSON.stringify(copy)},{sources:true});
const checked=await verifyHelper();
const result=spawnSync(checked.helperPath,['--probe'],{cwd:${JSON.stringify(copy)},encoding:'utf8',windowsHide:true,timeout:5000});
writeFileSync(${JSON.stringify(resolve(fixture, "probe-stdout.log"))},result.stdout??'');
writeFileSync(${JSON.stringify(resolve(fixture, "probe-stderr.log"))},result.stderr??'');
assert.equal(result.status,0,result.stderr);const probe=JSON.parse(result.stdout);
assert.equal(probe.version,1);assert.equal(probe.engines.unrestricted.available,true);
assert.equal(probe.engines.psec.readIsolation,false);
writeFileSync(${JSON.stringify(resolve(fixture, "verified-probe.json"))},JSON.stringify({helper:checked,manifestHelperSha256:manifest.helperSha256,probe,exitCode:result.status},null,2));
`)
  const result = spawnSync(process.execPath, [resolve(host, "node_modules/tsx/dist/cli.mjs"), entry], {
    cwd: copy, encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, I_HARNESS_DIST: "0", HOME: fixture, USERPROFILE: fixture, APPDATA: fixture,
      LOCALAPPDATA: fixture, TEMP: fixture, TMP: fixture },
  })
  writeFileSync(resolve(fixture, "verification-stdout.log"), result.stdout ?? "")
  writeFileSync(resolve(fixture, "verification-stderr.log"), result.stderr ?? "")
  console.log(`Fresh Git-byte verification evidence: ${fixture}`)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}, 30_000)
