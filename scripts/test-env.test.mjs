import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

const wrapper = fileURLToPath(new URL("./test-env.mjs", import.meta.url))
const repository = resolve(dirname(wrapper), "..")
const root = mkdtempSync(join(tmpdir(), "ih-test-env-"))
const fixture = join(root, "argument fixture.mjs")
writeFileSync(fixture, "console.log(JSON.stringify(process.argv.slice(2)))\n")
const values = ["two words", 'quoted "word"', "ampersand & echo literal", "(literal)", "100%", "tail\\"]

function invoke(command, args) {
  return spawnSync(process.execPath, [wrapper, command, ...args], {
    cwd: repository,
    env: { ...process.env, IH_CONFIG_DIR: join(root, "config") },
    windowsHide: true,
    encoding: "utf8",
  })
}

after(() => {
  assert.equal(dirname(root), resolve(tmpdir()))
  assert(root.startsWith(join(resolve(tmpdir()), "ih-test-env-")))
  rmSync(root, { recursive: true, force: true })
})

test("preserves executable arguments including whitespace and shell characters", () => {
  const result = invoke(process.execPath, [fixture, ...values])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), values)
})

test("preserves quoted filters through the actual pnpm launcher", () => {
  const result = invoke("pnpm", ["exec", "node", fixture, ...values])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), values)
})

test("preserves arguments through a Windows command shim", { skip: process.platform !== "win32" }, () => {
  const bin = join(root, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  const shim = join(bin, "argument-shim.cmd")
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
  const result = invoke(shim, values)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), values)
})

test("returns the child process exit status", () => {
  const result = invoke(process.execPath, ["-e", "process.exitCode = 23"])
  assert.equal(result.status, 23, result.stderr)
})
