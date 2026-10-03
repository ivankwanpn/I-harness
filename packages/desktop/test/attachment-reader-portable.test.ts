import { afterEach, expect, it } from "vitest"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { officeFixture, pdfFixture, zipFixture } from "./attachment-format-fixtures.ts"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it("runs every parser from a copied Electron payload without access to the source node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-parser-portable-")); roots.push(root)
  const main = join(root, "resources/app/out/main"); mkdirSync(main, { recursive: true })
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  for (const name of ["attachment-reader-worker.mjs", "pdf.worker.mjs", "cmaps", "standard_fonts", "wasm", "node_modules"]) cpSync(join(packageRoot, "out/main", name), join(main, name), { recursive: true, dereference: true })
  const formats = ["pdf", "docx", "xlsx", "pptx", "zip"]
  for (const format of formats) writeFileSync(join(root, `${format}.bin`), format === "pdf" ? pdfFixture() : format === "zip" ? zipFixture([{ name: "notes.txt", text: "attachment marker" }]) : officeFixture(format as "docx" | "xlsx" | "pptx"))
  const runner = join(root, "check.mjs")
  writeFileSync(runner, `import { Worker } from 'node:worker_threads'; import { readFileSync } from 'node:fs'; import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
for (const format of ['pdf','docx','xlsx','pptx','zip']) {
 const result = await new Promise((resolve,reject) => { const worker = new Worker(join(root,'resources/app/out/main/attachment-reader-worker.mjs'), {workerData:{format:'.'+format,bytes:new Uint8Array(readFileSync(join(root,format+'.bin')))}}); worker.once('error',reject); worker.once('message', message => { void worker.terminate(); if(message.error)reject(new Error(message.error));else resolve(message.result) }); });
 if (!result.text.includes('attachment marker')) throw new Error('Missing real text '+format);
 console.log(format+': readable copied payload');
}`)
  const executable = createRequire(import.meta.url)("electron") as string
  const result = spawnSync(executable, [runner], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" }, windowsHide: true, encoding: "utf8", timeout: 30_000 })
  expect(result.status, `${result.error?.message ?? ""}\n${result.stderr}`).toBe(0)
  for (const format of formats) expect(result.stdout).toContain(`${format}: readable copied payload`)
}, 40_000)
