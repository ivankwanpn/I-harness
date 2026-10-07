/** Real Windows behavioral qualification. All mutable paths live in one new owned fixture. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { release as osRelease, version as osVersion } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compileExecutionPolicy, assertExecutionAuthority } from "@i-harness/sandbox-policy"
import { createExecutionSupervisor } from "@i-harness/exec"
import type { AuthorityState, ProcessSpec, SandboxMode } from "@i-harness/sandbox"
import { createWindowsPsecBackend, createWindowsUnrestrictedBackend } from "../src/index.ts"

if (process.platform !== "win32") throw new Error("Windows qualification requires Windows")
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const packageRoot = resolve(repo, "packages/sandbox-windows-psec")
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "artifacts/win32-x64/manifest.json"), "utf8"))
const helper = resolve(packageRoot, "artifacts/win32-x64", manifest.helperFile)
const helperHash = createHash("sha256").update(readFileSync(helper)).digest("hex")
assert.equal(helperHash, manifest.helperSha256)
const fixture = mkdtempSync(resolve(repo, ".tmp/sandbox-redesign-qualification-"))
const workspace = resolve(fixture, "workspace")
const reference = resolve(fixture, "reference")
const denied = resolve(workspace, "protected")
for (const p of [workspace, reference, denied]) mkdirSync(p, { recursive: true })
const referenceFile = resolve(reference, "reference.txt")
const deniedFile = resolve(denied, "protected.txt")
writeFileSync(referenceFile, "REFERENCE-UNCHANGED\n")
writeFileSync(deniedFile, "PROTECTED-UNCHANGED\n")
const alias = resolve(workspace, "reference-junction")
let junction: string | undefined
try { symlinkSync(reference, alias, "junction"); junction = alias } catch (error) { junction = `unavailable: ${String(error)}` }
const snapshot = (path: string) => {
  const s = statSync(path)
  const acl = spawnSync("icacls.exe", [path], { encoding: "utf8", windowsHide: true })
  return { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), size: s.size,
    birthtimeMs: s.birthtimeMs, mtimeMs: s.mtimeMs, mode: s.mode, acl: acl.stdout.trim(), aclExit: acl.status }
}
const before = { reference: snapshot(referenceFile), denied: snapshot(deniedFile) }
const results: { name: string; outcome: "pass" | "fail" | "unsupported"; detail: unknown }[] = []
async function test(name: string, run: () => Promise<unknown>, unsupported = false) {
  try { const detail = await run(); results.push({ name, outcome: "pass", detail }); console.log(`PASS ${name}`) }
  catch (error) {
    const detail = error instanceof ObservationFailure ? error.detail : String(error)
    const outcome = unsupported && error instanceof ObservationFailure ? "unsupported" : "fail"
    results.push({ name, outcome, detail })
    console.log(`${outcome.toUpperCase()} ${name}: ${error instanceof ObservationFailure ? error.message : String(error)}`)
  }
}
class ObservationFailure extends Error { constructor(message: string, readonly detail: unknown) { super(message) } }
const owner = { sessionId: `qualification-${randomUUID()}` }
const manifestPath = resolve(packageRoot, "artifacts/win32-x64/manifest.json")
const psec = createWindowsPsecBackend({ manifestPath, denyPaths: [denied] })
const psecNoDeny = createWindowsPsecBackend({ manifestPath })
const unrestricted = createWindowsUnrestrictedBackend({ manifestPath })
const supervisor = createExecutionSupervisor()
const baseEnv: Record<string, string> = {
  SystemRoot: process.env.SystemRoot!, SystemDrive: process.env.SystemDrive!, windir: process.env.SystemRoot!,
  USERPROFILE: workspace, APPDATA: workspace, LOCALAPPDATA: workspace, TEMP: workspace, TMP: workspace,
  PATH: process.env.PATH ?? "", COMSPEC: process.env.ComSpec ?? resolve(process.env.SystemRoot!, "System32/cmd.exe"),
  QUALIFICATION_MARKER: "explicit-env", EMPTY_VALUE: "",
}
type Engine = "psec" | "unrestricted"
async function run(engine: Engine, mode: SandboxMode, argv: string[], opts: {
  refs?: string[]; backend?: typeof psec; env?: Record<string, string>; cwd?: string; transport?: "pipe" | "pty";
  lifetime?: "complete-tree" | "retain-tree"; input?: Uint8Array; resize?: [number, number]; cancel?: "cancelled" | "timeout";
  cancelAfterMs?: number; timeoutMs?: number; encoding?: "crt" | "cmd-verbatim"; consumeOutput?: boolean;
  atRootExit?: () => void;
} = {}) {
  const backend = opts.backend ?? (engine === "psec" ? psecNoDeny : unrestricted)
  const authority: AuthorityState = { kind: "bound", revision: "qualification-1", primaryRoot: workspace,
    roots: [workspace], references: opts.refs ?? [] }
  const policy = compileExecutionPolicy({ mode, owner, authority })
  const spec: ProcessSpec = { argv, cwd: opts.cwd ?? workspace, env: opts.env ?? baseEnv, owner,
    transport: opts.transport ?? "pipe", lifetime: opts.lifetime ?? "complete-tree", argumentEncoding: opts.encoding ?? "crt",
    ...(opts.transport === "pty" ? { pty: { cols: 80, rows: 24 } } : {}) }
  const requirements = { writeIsolation: engine === "psec", readIsolation: false, denyPaths: engine === "psec" && backend === psec,
    transport: spec.transport, lifetime: spec.lifetime, minimumAssurance: "unverified" as const }
  const launched = await supervisor.launch({ backend, spec, policy, requirements, validateAuthority: current => assertExecutionAuthority(policy, current) })
  const { handle } = launched
  const chunks: Record<string, Buffer[]> = { stdout: [], stderr: [], pty: [] }
  const drain = opts.consumeOutput === false ? Promise.resolve() : (async () => {
    for await (const output of handle.io.output) chunks[output.channel]!.push(Buffer.from(output.data))
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`watchdog ${opts.timeoutMs ?? 12000} ms`)), opts.timeoutMs ?? 12000) })
  try {
    if (opts.resize) { assert(handle.io.resize); await handle.io.resize(...opts.resize) }
    if (opts.input) { await handle.io.write(opts.input); if (spec.transport === "pipe") await handle.io.endInput() }
    if (opts.cancel) { await new Promise(resolve => setTimeout(resolve, opts.cancelAfterMs ?? 200)); await supervisor.cancel(launched.id, opts.cancel) }
    const root = await Promise.race([handle.rootExited, watchdog])
    opts.atRootExit?.()
    const settlement = await Promise.race([handle.settled, watchdog])
    await Promise.race([drain, watchdog])
    return { pid: handle.pid, root, settlement, receipt: handle.receipt, diagnostics: handle.io.diagnostics?.(),
      stdout: Buffer.concat(chunks.stdout!), stderr: Buffer.concat(chunks.stderr!), pty: Buffer.concat(chunks.pty!) }
  } finally {
    if (timer) clearTimeout(timer)
    await handle.release()
  }
}
function settled(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.settlement.kind, "settled", JSON.stringify(result.settlement))
  assert.equal(result.diagnostics?.outputAbandoned, false)
  assert.equal(result.diagnostics?.discardedOutputBytes, 0)
}
const self = (...args: string[]) => [helper, "--self-child", ...args]
const node = resolve(process.env.ProgramFiles ?? "C:/Program Files", "nodejs/node.exe")
const git = resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/cmd/git.exe")
const bash = resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe")
const bashDirect = resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/bash.exe")
const cmd = resolve(process.env.SystemRoot!, "System32/cmd.exe")
const powershell = resolve(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
const js = resolve(workspace, "qualification-child.cjs")
const tsxCli = resolve(repo, "node_modules/tsx/dist/cli.mjs")
const tsxChild = resolve(workspace, "qualification-tsx.ts")
writeFileSync(tsxChild, "import { stdin, stdout } from 'node:process'; let text = ''; stdin.setEncoding('utf8'); stdin.on('data', part => text += part); stdin.on('end', () => stdout.write('tsx:' + text));\n")
writeFileSync(js, `const fs=require('fs'); const net=require('net'); const [kind,...args]=process.argv.slice(2);\nif(kind==='identity'){process.stdout.write(JSON.stringify({argv:args,cwd:process.cwd(),marker:process.env.QUALIFICATION_MARKER,empty:process.env.EMPTY_VALUE,missing:process.env.UNDECLARED_QUALIFICATION_KEY??null}));}\nelse if(kind==='binary'){process.stdout.write(Buffer.from([0,255,1,10]));process.stderr.write(Buffer.from([254,0,2]));}\nelse if(kind==='exit'){process.exit(259);}\nelse if(kind==='network'){const s=net.connect(Number(args[0]),'127.0.0.1');s.setTimeout(2500);s.on('connect',()=>{console.log('CONNECTED');s.end()});s.on('timeout',()=>{console.log('TIMEOUT');s.destroy()});s.on('error',e=>{console.log('ERROR:'+e.code)});}\n`)
try {
  await test("helper-integrity-and-probe", async () => ({ helperSha256: helperHash, psec: await psec.probe(), unrestricted: await unrestricted.probe() }))
  for (const mode of ["workspace-write", "read-only"] as const) await test(`psec-filesystem-${mode}`, async () => {
    const allowed = resolve(workspace, `allowed-${mode}.txt`)
    const result = await run("psec", mode, self("filesystem", allowed, referenceFile, deniedFile, referenceFile), { refs: [reference], backend: psec })
    settled(result)
    const observed = JSON.parse(result.stdout.toString())
    assert.equal(observed.readOnlyRead, "REFERENCE-UNCHANGED\n")
    assert.equal(observed.allowedWrite, mode === "workspace-write")
    assert.equal(observed.readOnlyWrite, false)
    assert.equal(observed.deniedRead, false)
    assert.equal(observed.deniedWrite, false)
    assert.equal(existsSync(allowed), mode === "workspace-write")
    return observed
  })
  if (junction && !junction.startsWith("unavailable")) await test("psec-junction-alias-reference", async () => {
    const aliased = resolve(junction!, "reference.txt")
    const result = await run("psec", "workspace-write", self("filesystem", resolve(workspace, "alias-allowed.txt"), referenceFile, deniedFile, aliased), { refs: [reference], backend: psec })
    settled(result)
    const observed = JSON.parse(result.stdout.toString())
    assert.equal(observed.readOnlyWrite, false)
    return observed
  })
  else results.push({ name: "psec-junction-alias-reference", outcome: "unsupported", detail: junction })
  await test("unrestricted-refuses-reference-lock", async () => {
    await assert.rejects(run("unrestricted", "danger-full-access", self("basic"), { refs: [reference] }), /mandatory reference/)
    return { refused: true }
  })
  await test("unrestricted-refuses-deny-lock", async () => {
    const locked = createWindowsUnrestrictedBackend({ manifestPath, denyPaths: [denied] })
    try { await assert.rejects(run("unrestricted", "danger-full-access", self("basic"), { backend: locked }), /mandatory reference or deny/); return { refused: true } }
    finally { await locked.dispose() }
  })
  await test("psec-missing-LOCALAPPDATA-203", async () => {
    const env = { ...baseEnv }; delete env.LOCALAPPDATA
    await assert.rejects(run("psec", "workspace-write", self("basic"), { env }), /203/)
    return { nativeError: 203, explicitEnvPreserved: true }
  })
  for (const engine of ["unrestricted", "psec"] as const) {
    const mode = engine === "psec" ? "workspace-write" : "danger-full-access"
    await test(`${engine}-node-exact-argv-cwd-env`, async () => {
      const args = ["a b", "quote\"x", "", "終端"]
      const result = await run(engine, mode, [node, js, "identity", ...args])
      settled(result); assert.equal(result.root.exitCode, 0)
      assert.deepEqual(JSON.parse(result.stdout.toString()), { argv: args, cwd: workspace, marker: "explicit-env", empty: "", missing: null })
      return { observed: JSON.parse(result.stdout.toString()), pid: result.pid }
    }, engine === "psec")
    await test(`${engine}-node-binary-pipes`, async () => {
      const result = await run(engine, mode, [node, js, "binary"])
      settled(result); assert.deepEqual([...result.stdout], [0, 255, 1, 10]); assert.deepEqual([...result.stderr], [254, 0, 2]); return { stdout: [...result.stdout], stderr: [...result.stderr] }
    }, engine === "psec")
    await test(`${engine}-full-width-exit`, async () => {
      const result = await run(engine, mode, [node, js, "exit"])
      settled(result); assert.equal(result.root.exitCode, 259); return result.root
    }, engine === "psec")
    await test(`${engine}-native-pipe-input`, async () => {
      const input = Buffer.from([0, 255, 1, 10])
      const result = await run(engine, mode, self("echo"), { input })
      settled(result); assert.deepEqual(result.stdout, input); return { bytes: [...result.stdout] }
    })
    await test(`${engine}-tsx-pipe`, async () => {
      const result = await run(engine, mode, [node, tsxCli, tsxChild], { input: Buffer.from("tsx-pipe-proof") })
      settled(result); assert.equal(result.root.exitCode, 0, result.stderr.toString())
      assert.equal(result.stdout.toString(), "tsx:tsx-pipe-proof")
      return { exit: result.root.exitCode, output: result.stdout.toString() }
    }, engine === "psec")
    await test(`${engine}-retain-descendant`, async () => {
      const marker = resolve(workspace, `retained-${engine}.txt`)
      const result = await run(engine, mode, self("spawn-descendant", "500", marker), {
        lifetime: "retain-tree", atRootExit: () => assert.equal(existsSync(marker), false),
      })
      settled(result); assert.equal(result.root.exitCode, 17); assert.equal(readFileSync(marker, "utf8"), "descendant-finished")
      const descendant = Number(result.stdout.toString().match(/descendant-pid=(\d+)/)?.[1])
      assert(Number.isInteger(descendant) && descendant > 0)
      const childCheck = spawnSync("tasklist.exe", ["/FI", `PID eq ${descendant}`, "/NH"], { encoding: "utf8", windowsHide: true })
      assert(!childCheck.stdout.includes(String(descendant)), `descendant ${descendant} still listed`)
      return { rootExit: result.root.exitCode, marker, treeEmpty: true, descendantPid: descendant, descendantNotListed: true }
    })
    await test(`${engine}-job-cancel-timeout`, async () => {
      const result = await run(engine, mode, self("never-read"), { cancel: "timeout", cancelAfterMs: 100 })
      assert.equal(result.settlement.kind, "settled"); return { settlement: result.settlement, diagnostics: result.diagnostics }
    })
    await test(`${engine}-job-cancel-descendant`, async () => {
      const marker = resolve(workspace, `cancel-descendant-${engine}.txt`)
      const result = await run(engine, mode, self("spawn-descendant", "5000", marker), {
        lifetime: "retain-tree", cancel: "cancelled", cancelAfterMs: 150,
      })
      assert.equal(result.settlement.kind, "settled")
      assert.equal(existsSync(marker), false)
      const descendant = Number(result.stdout.toString().match(/descendant-pid=(\d+)/)?.[1])
      assert(Number.isInteger(descendant) && descendant > 0)
      const childCheck = spawnSync("tasklist.exe", ["/FI", `PID eq ${descendant}`, "/NH"], { encoding: "utf8", windowsHide: true })
      assert(!childCheck.stdout.includes(String(descendant)), `descendant ${descendant} still listed`)
      return { root: result.root, descendantPid: descendant, markerAbsent: true, descendantNotListed: true, settlement: result.settlement }
    })
    await test(`${engine}-output-cancel-accounting`, async () => {
      const result = await run(engine, mode, self("flood"), { cancel: "cancelled", cancelAfterMs: 250, consumeOutput: false })
      assert.equal(result.settlement.kind, "settled")
      assert.equal(result.diagnostics?.outputAbandoned, true)
      assert((result.diagnostics?.discardedOutputBytes ?? 0) > 0)
      return { settlement: result.settlement, diagnostics: result.diagnostics }
    })
    await test(`${engine}-cmd`, async () => {
      const result = await run(engine, mode, [cmd, "/d", "/s", "/c", "echo cmd-qualification"], { encoding: "cmd-verbatim" })
      settled(result); assert.match(result.stdout.toString(), /cmd-qualification/); return { exit: result.root.exitCode, output: result.stdout.toString() }
    }, engine === "psec")
    await test(`${engine}-powershell`, async () => {
      const result = await run(engine, mode, [powershell, "-NoProfile", "-Command", "[Console]::Out.Write('powershell-qualification')"])
      settled(result); assert.match(result.stdout.toString(), /powershell-qualification/); return { exit: result.root.exitCode, output: result.stdout.toString() }
    }, engine === "psec")
    await test(`${engine}-git`, async () => {
      const result = await run(engine, mode, [git, "--version"])
      settled(result); assert.match(result.stdout.toString(), /git version/); return { exit: result.root.exitCode, output: result.stdout.toString() }
    }, engine === "psec")
    await test(`${engine}-msys-bash-pipe`, async () => {
      const argv = [bash, "-c", "printf 'bash-qualification\\n'; cat"]
      const result = await run(engine, mode, argv, { input: Buffer.from("stdin-through-bash\n") })
      settled(result)
      const detail = { pid: result.pid, argv, cwd: workspace, env: baseEnv, inputUtf8: "stdin-through-bash\n",
        root: result.root, settlement: result.settlement, diagnostics: result.diagnostics,
        stdout: result.stdout.toString(), stderr: result.stderr.toString() }
      if (result.root.exitCode === 3221225794 && result.stderr.toString().includes("NtCreateDirectoryObject")
        && result.stderr.toString().includes("0xC0000022")) {
        throw new ObservationFailure(`Bash workload did not complete: root=${result.root.exitCode}; stderr=${result.stderr.toString().trim()}`, detail)
      }
      assert.equal(result.root.exitCode, 0, result.stderr.toString())
      assert.match(result.stdout.toString(), /bash-qualification/)
      assert.match(result.stdout.toString(), /stdin-through-bash/)
      return detail
    }, engine === "psec")
  }
  for (const [image, executable, lifetime] of [
    ["launcher", bash, "retain-tree"], ["direct", bashDirect, "complete-tree"], ["direct", bashDirect, "retain-tree"],
  ] as const) await test(`psec-msys-matrix-${image}-${lifetime}`, async () => {
    assert(existsSync(executable), `missing Bash image ${executable}`)
    const argv = [executable, "-c", "printf 'bash-qualification\\n'; cat"]
    const result = await run("psec", "workspace-write", argv, { lifetime, input: Buffer.from("stdin-through-bash\n") })
    settled(result)
    const detail = { image, pid: result.pid, argv, cwd: workspace, env: baseEnv, lifetime,
      root: result.root, settlement: result.settlement, diagnostics: result.diagnostics,
      stdout: result.stdout.toString(), stderr: result.stderr.toString() }
    if (result.root.exitCode === 3221225794 && result.stderr.toString().includes("NtCreateDirectoryObject")
      && result.stderr.toString().includes("0xC0000022")) {
      throw new ObservationFailure(`MSYS named-object initialization denied for ${image}/${lifetime}`, detail)
    }
    assert.equal(result.root.exitCode, 0, JSON.stringify(detail))
    assert.match(result.stdout.toString(), /bash-qualification/, JSON.stringify(detail))
    assert.match(result.stdout.toString(), /stdin-through-bash/, JSON.stringify(detail))
    return detail
  }, true)
  await test("psec-pty-rejected-before-workload", async () => {
    await assert.rejects(run("psec", "workspace-write", self("read-line"), { transport: "pty" }), /pty|transport/i)
    return { noWorkload: true }
  })
  await test("unrestricted-pty-input-resize", async () => {
    const result = await run("unrestricted", "danger-full-access", self("read-line"), { transport: "pty", input: Buffer.from("pty-input\r\n"), resize: [100, 30] })
    settled(result); assert.match(result.pty.toString(), /received:pty-input/); return { output: result.pty.toString(), settlement: result.settlement }
  })
  await test("unrestricted-pty-retain-descendant", async () => {
    const marker = resolve(workspace, "pty-retained.txt")
    const result = await run("unrestricted", "danger-full-access", self("spawn-descendant", "500", marker), {
      transport: "pty", lifetime: "retain-tree", atRootExit: () => assert.equal(existsSync(marker), false),
    })
    settled(result)
    assert.equal(result.root.exitCode, 17)
    assert.equal(readFileSync(marker, "utf8"), "descendant-finished")
    return { root: result.root, markerAfterRoot: true, settlement: result.settlement }
  })
  const server = createServer(socket => socket.end("ok"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address(); assert(address && typeof address !== "string")
    const host = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(node, [js, "network", String(address.port)], { cwd: workspace, env: baseEnv, windowsHide: true })
      let out = ""; child.stdout.on("data", b => out += b.toString()); child.on("error", reject); child.on("exit", () => resolveResult(out.trim()))
    })
    await test("host-loopback-positive", async () => { assert.equal(host, "CONNECTED"); return { result: host, port: address.port } })
    await test("psec-loopback-egress-denial", async () => {
      const result = await run("psec", "workspace-write", [node, js, "network", String(address.port)])
      settled(result); const observed = result.stdout.toString().trim(); assert.notEqual(observed, "CONNECTED"); assert.match(observed, /ERROR:|TIMEOUT/)
      return { observed, hostPositive: host }
    }, true)
  } finally { server.close() }
} finally {
  const after = { reference: snapshot(referenceFile), denied: snapshot(deniedFile) }
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  results.push({ name: "protected-reference-content-metadata-acl", outcome: unchanged ? "pass" : "fail", detail: { before, after } })
  const evidence = { generatedAt: new Date().toISOString(), fixture, packageRoot, helper, helperSha256: helperHash,
    manifest, platform: process.platform, node: process.version, windowsRelease: osRelease(), windowsVersion: osVersion(), junction,
    protectedBefore: before, protectedAfter: after, protectedUnchanged: unchanged, results }
  writeFileSync(resolve(fixture, "qualification-results.json"), JSON.stringify(evidence, null, 2))
  console.log(`Evidence: ${resolve(fixture, "qualification-results.json")}`)
  await supervisor.dispose().catch(error => console.error(`Supervisor cleanup: ${String(error)}`))
  await Promise.all([psec.dispose(), psecNoDeny.dispose(), unrestricted.dispose()]).catch(error => console.error(`Backend cleanup: ${String(error)}`))
}
// A required source family remaining unsupported is a qualification gate, not green CI.
if (results.some(result => result.outcome === "fail")) process.exitCode = 1
else if (results.some(result => result.outcome === "unsupported")) process.exitCode = 2
