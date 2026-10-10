import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"
const root = resolve(import.meta.dirname, "../../..")
const require = createRequire(join(root, "packages/session-executor/package.json"))
const { createExecService } = await import(pathToFileURL(require.resolve("@i-harness/exec")).href)
const koffi = createRequire(join(root, "packages/sandbox-windows-acl/package.json"))("koffi")
const kernel = koffi.load("kernel32.dll")
const open = kernel.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)")
const code = kernel.func("int __stdcall GetExitCodeProcess(void *, _Out_ uint32_t *)")
const close = kernel.func("int __stdcall CloseHandle(void *)")
mkdirSync(join(root, ".tmp"), { recursive: true })
const fixture = mkdtempSync(join(root, ".tmp/sandbox-redesign-node-exit-"))
process.env.TEMP = fixture; process.env.TMP = fixture
const child = join(fixture, "child.cjs"), parent = join(fixture, "parent.cjs")
const pidFile = join(fixture, "child-pid.json"), gate = join(fixture, "gate"), started = join(fixture, "started"), done = join(fixture, "done")
writeFileSync(child, `require('fs').writeFileSync(process.argv[2],'started');setTimeout(()=>require('fs').writeFileSync(process.argv[3],'done'),750)`)
writeFileSync(parent, `const fs=require('fs');const c=require('child_process').spawn(process.execPath,process.argv.slice(2,5),{stdio:'inherit',env:process.env});c.unref();fs.writeFileSync(process.argv[5],JSON.stringify({pid:c.pid}));setInterval(()=>{if(fs.existsSync(process.argv[6]))process.exit(0)},5)`)
const environmentDigest = createHash("sha256").update(JSON.stringify(Object.entries(process.env).sort())).digest("hex")
const execution = createExecService({ workspaceRoot: fixture })
let query: unknown, result: any = { fixture, environmentDigest, observer: "OpenProcess QUERY_LIMITED_INFORMATION|SYNCHRONIZE before parent exit" }
try {
  const launch = await execution.launchTransport({ argv: [process.execPath, parent, child, started, done, pidFile, gate], cwd: fixture,
    transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt", pty: { cols: 80, rows: 24 } })
  const output: Uint8Array[] = []
  const drain = (async () => { for await (const frame of launch.handle.io.output) output.push(frame.data) })()
  const deadline = Date.now() + 15000
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  const { pid } = JSON.parse(readFileSync(pidFile, "utf8")); result.childPid = pid
  query = open(0x1000 | 0x100000, 0, pid)
  if (!query) throw new Error("Cannot hold owned child query handle")
  const before = [0]; if (!code(query, before)) throw new Error("Child status query failed")
  result.beforeParentExit = before[0]
  writeFileSync(gate, "trusted observer holds child handle")
  result.root = await launch.handle.rootExited
  result.settlement = await launch.handle.settled
  await drain
  const after = [0]; if (!code(query, after)) throw new Error("Child final query failed")
  result.childExitCode = after[0]; result.childExitHex = `0x${after[0]!.toString(16)}`
  result.started = existsSync(started); result.done = existsSync(done)
  result.outputBytes = output.reduce((n, item) => n + item.length, 0)
} finally {
  if (query) close(query)
  await execution.dispose()
  writeFileSync(join(fixture, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}
