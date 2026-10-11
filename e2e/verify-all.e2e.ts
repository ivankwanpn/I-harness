import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const script = fileURLToPath(new URL("../scripts/verify-all.mjs", import.meta.url))

it("verify:all reports dependent projects after an earlier project fails and retains the failing exit code", async () => {
  const base = resolve("build/verify-all-fixtures"); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, "fixture-"))
  const put = async (path: string, content: string) => {
    const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content)
  }
  try {
    await put("package.json", JSON.stringify({ name: "verification-fixture", private: true, scripts: { e2e: "node e2e.mjs" } }))
    await put("pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\n")
    await put("scripts/verify-all.mjs", await readFile(script, "utf8"))
    await put("packages/desktop/scripts/build-attachment-reader.mjs", "")
    await put("scripts/audit/check-reachability.mjs", "console.log('reachability: controlled fixture')")
    await put("e2e.mjs", "console.log('✓ e2e/fixture.e2e.ts (1 test)')")
    await put("typecheck.mjs", "")
    for (const [name, dependencies, summary, code] of [
      ["a", {}, "1 failed", 1],
      ["b", { "fixture-a": "workspace:*" }, "2 passed", 0],
      ["c", { "fixture-b": "workspace:*" }, "3 passed", 0],
    ] as const) {
      await put(`packages/${name}/package.json`, JSON.stringify({ name: `fixture-${name}`, version: "1.0.0", dependencies,
        scripts: { test: "node test.mjs", typecheck: "node ../../typecheck.mjs" } }))
      await put(`packages/${name}/test.mjs`, `import {appendFileSync} from 'node:fs'; appendFileSync('../../ran.txt','${name}\\n'); console.log(' Test Files 1 ${code ? "failed" : "passed"} (1)'); console.log('      Tests ${summary}'); process.exit(${code});`)
    }
    const result = await execute(process.execPath, [join(root, "scripts/verify-all.mjs")], { cwd: root, timeout: 15000, windowsHide: true })
      .then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }))
    expect(result.code).toBe(1)
    expect((await readFile(join(root, "ran.txt"), "utf8")).trim().split(/\r?\n/)).toEqual(["a", "b", "c"])
    expect(result.stdout).toMatch(/population\s+: 3 of 3 projects reported/)
    expect(result.stdout).toMatch(/suite\s+: exit 1 · 5 passed \| 0 skipped \| 1 failed/)
    expect(result.stdout).toContain("VERIFY:ALL FAILED")
    expect(result.stdout).not.toContain("SHORT RUN")
  } finally { await rm(root, { recursive: true, force: true }) }
})
