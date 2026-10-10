import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, existsSync, renameSync, writeFileSync, linkSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createWslExecutionBackend } from "../../../packages/sandbox-wsl/src/index.ts"
import type { WslDiagnostics, WslExecutionBackend } from "../../../packages/sandbox-wsl/src/index.ts"
import { createExecutionSupervisor } from "../../../packages/exec/src/index.ts"
import { compileExecutionPolicy } from "../../../packages/sandbox-policy/src/index.ts"
import type { ProcessSpec, SandboxMode, TransportExecutionHandle } from "../../../packages/sandbox/src/index.ts"

const args = process.argv.slice(2)
if (args.length !== 0 && !(args.length === 2 && args[0] === "--distribution" && args[1])) {
  throw new Error("Usage: node --import tsx scripts/qualification/wsl2-sandbox/run.mts [--distribution Ubuntu]")
}
const distribution = args[1] ?? "Ubuntu"
if (process.platform !== "win32") throw new Error("This qualification exercises the Windows-to-WSL2 controller")
const parent = resolve(".tmp")
mkdirSync(parent, { recursive: true })
const fixture = mkdtempSync(join(parent, "wsl2-qualification-"))
const work = join(fixture, "workspace")
const sibling = join(fixture, "sibling")
const reference = join(fixture, "reference")
for (const path of [work, sibling, reference]) mkdirSync(path)
writeFileSync(join(reference, "kept.txt"), "REFERENCE_ORIGINAL")
const report: { date: string; distribution: string; fixture: string; probe?: unknown; cases: unknown[];
  failure?: string; failureDetails?: string[]; launcherDiagnostics?: readonly WslDiagnostics[] } = {
  date: new Date().toISOString(), distribution, fixture, cases: [],
}
const reportPath = join(fixture, "qualification.json")
function save() { writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n") }
const backend: WslExecutionBackend = createWslExecutionBackend({ distribution })
const supervisor = createExecutionSupervisor()
const environment = { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/tmp" }
const requirements = { writeIsolation: true, readIsolation: false, denyPaths: false,
  transport: "pipe" as const, lifetime: "complete-tree" as const, minimumAssurance: "experimental" as const }
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
function errorDetails(cause: unknown, depth = 0): string[] {
  if (depth > 4) return []
  const text = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2048)
  return [text, ...(cause instanceof AggregateError ? [...cause.errors].flatMap(error => errorDetails(error, depth + 1)) : []),
    ...(cause instanceof Error && cause.cause ? errorDetails(cause.cause, depth + 1) : [])]
}

function request(mode: SandboxMode, argv: string[], root = work) {
  const owner = { sessionId: "wsl-qualification-" + randomUUID() }
  const policy = compileExecutionPolicy({ mode, owner,
    authority: { kind: "bound", revision: "1", primaryRoot: root, roots: [root], references: [reference] } })
  const spec: ProcessSpec = { argv, cwd: root, env: environment, owner,
    transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" }
  return { policy, spec }
}

async function launch(mode: SandboxMode, argv: string[]) {
  const input = request(mode, argv)
  const execution = await supervisor.launch({ ...input, backend, requirements,
    signal: AbortSignal.timeout(30000), validateAuthority: actual => {
      assert.equal(actual.fingerprint, input.policy.fingerprint)
    } })
  return execution
}

async function collect(handle: TransportExecutionHandle, readyText?: string) {
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let announce!: () => void
  const ready = new Promise<void>(done => { announce = done })
  if (!readyText) announce()
  const drained = (async () => {
    for await (const frame of handle.io.output) {
      assert.notEqual(frame.channel, "pty")
      ;(frame.channel === "stdout" ? stdout : stderr).push(Buffer.from(frame.data))
      if (readyText && Buffer.concat(stdout).toString().includes(readyText)) announce()
    }
  })()
  void drained.catch(() => {})
  const reached = readyText ? Promise.race([ready, drained.then(() => {
    if (!Buffer.concat(stdout).toString().includes(readyText)) throw new Error("Workload ended before readiness marker")
  })]) : ready
  return { ready: reached, drained, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr) }
}

async function execute(mode: SandboxMode, argv: string[], input?: Buffer) {
  const execution = await launch(mode, argv)
  const output = await collect(execution.handle)
  if (input) await execution.handle.io.write(input)
  await execution.handle.io.endInput()
  await output.drained
  const settled = await execution.handle.settled
  assert.equal(settled.kind, "settled")
  const observed = { receipt: execution.handle.receipt, settlement: settled,
    stdoutBase64: output.stdout().toString("base64"), stderrBase64: output.stderr().toString("base64") }
  return { observed, stdout: output.stdout(), stderr: output.stderr(), root: await execution.handle.rootExited }
}

async function test(name: string, operation: () => Promise<unknown>) {
  const start = Date.now()
  try {
    const evidence = await operation()
    report.cases.push({ name, passed: true, elapsedMs: Date.now() - start, evidence })
    save()
    process.stdout.write("PASS " + name + "\n")
  } catch (cause) {
    report.cases.push({ name, passed: false, elapsedMs: Date.now() - start,
      failure: cause instanceof Error ? cause.message : String(cause), failureDetails: errorDetails(cause) })
    save()
    throw cause
  }
}

async function listener() {
  const script = "import socket,sys\ns=socket.socket();s.bind(('127.0.0.1',0));s.listen(4)\nprint(s.getsockname()[1],flush=True)\nsys.stdin.buffer.read(1)\ns.close()"
  const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe"),
    ["--distribution", distribution, "--exec", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C",
      "/usr/bin/python3", "-I", "-B", "-u", "-c", script],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  child.stderr.resume()
  const closed = new Promise<void>((yes, no) => {
    child.once("error", no)
    child.once("close", code => code === 0 ? yes() : no(new Error("Controlled WSL listener failed")))
  })
  void closed.catch(() => {})
  let port: number
  try { port = await new Promise<number>((yes, no) => {
    let text = ""
    const timer = setTimeout(() => no(new Error("Listener readiness timed out")), 10000)
    child.once("error", error => { clearTimeout(timer); no(error) })
    child.stdout.on("data", data => {
      text += data.toString()
      if (text.includes("\n")) {
        clearTimeout(timer)
        const value = Number(text.trim())
        if (!Number.isInteger(value) || value < 1 || value > 65535) no(new Error("Invalid controlled port"))
        else yes(value)
      }
    })
  }) } catch (cause) { child.stdin.end(); await closed.catch(() => {}); throw cause }
  return { port, close: async () => { child.stdin.end("\n"); await closed } }
}

try {
  report.probe = await backend.probe()
  save()
  assert.equal((report.probe as { availability: string }).availability, "available")
  await test("read-only Bash, pipeline, child and denied writes", async () => {
    const result = await execute("read-only", ["/usr/bin/bash", "--noprofile", "--norc", "-c", `
set -e; set -o pipefail
printf 'BASH_START\n'; printf 'WORKLOAD_ERR\n' >&2
/usr/bin/bash --noprofile --norc -c 'printf "NESTED_CHILD\\n"'
printf 'pipeline\n' | /usr/bin/tr '[:lower:]' '[:upper:]'
if printf X > ro-new.txt; then printf 'CWD_ALLOW\n'; else printf 'CWD_DENY\n'; fi
if printf X > ../sibling/ro-new.txt; then printf 'SIBLING_ALLOW\n'; else printf 'SIBLING_DENY\n'; fi
if printf X > ../reference/kept.txt; then printf 'REFERENCE_ALLOW\n'; else printf 'REFERENCE_DENY\n'; fi
cat ../reference/kept.txt; printf '\nBASH_DONE\n'
`])
    assert.equal(result.root.exitCode, 0)
    for (const marker of ["BASH_START", "NESTED_CHILD", "PIPELINE", "CWD_DENY", "SIBLING_DENY", "REFERENCE_DENY", "REFERENCE_ORIGINAL", "BASH_DONE"])
      assert.ok(result.stdout.toString().includes(marker), marker)
    assert.ok(result.stderr.toString().includes("WORKLOAD_ERR"))
    assert.ok(!existsSync(join(work, "ro-new.txt")) && !existsSync(join(sibling, "ro-new.txt")))
    assert.equal(readFileSync(join(reference, "kept.txt"), "utf8"), "REFERENCE_ORIGINAL")
    return result.observed
  })
  await test("workspace write with sibling/reference denied", async () => {
    const result = await execute("workspace-write", ["/usr/bin/bash", "--noprofile", "--norc", "-c", `
set -e
printf 'WORKSPACE_WRITTEN' > ww-new.txt
if printf X > ../sibling/ww-new.txt; then exit 91; fi
if printf X > ../reference/kept.txt; then exit 92; fi
printf 'WRITE_BOUNDARY_OK\n'
`])
    assert.equal(result.root.exitCode, 0)
    assert.equal(readFileSync(join(work, "ww-new.txt"), "utf8"), "WORKSPACE_WRITTEN")
    assert.ok(!existsSync(join(sibling, "ww-new.txt")))
    assert.equal(readFileSync(join(reference, "kept.txt"), "utf8"), "REFERENCE_ORIGINAL")
    return result.observed
  })
  await test("binary output and exact nonzero root status", async () => {
    const result = await execute("read-only", ["/usr/bin/python3", "-I", "-B", "-c",
      "import sys;sys.stdout.buffer.write(bytes([0,255,128,10]));sys.stderr.buffer.write(b'ERR');sys.exit(7)"])
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 128, 10]))
    assert.equal(result.stderr.toString(), "ERR")
    assert.equal(result.root.exitCode, 7)
    return result.observed
  })
  await test("binary command stdin is distinct from controls", async () => {
    const bytes = Buffer.from([0, 255, 9, 10, 123, 34, 118, 34, 58, 49, 125, 10])
    const result = await execute("read-only", ["/usr/bin/python3", "-I", "-B", "-c",
      "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())"], bytes)
    assert.deepEqual(result.stdout, bytes)
    assert.equal(result.root.exitCode, 0)
    return result.observed
  })
  await test("AF_UNIX and Windows interop blocked", async () => {
    const escaped = join(work, "interop-escaped.txt")
    const windowsCommand = `echo ESCAPED>"${escaped}"`
    const script = `import socket,subprocess,sys
try:
 socket.socket(socket.AF_UNIX)
except PermissionError: print('UNIX_DENIED')
else: sys.exit(93)
try:
 subprocess.run(['/mnt/c/Windows/System32/cmd.exe','/d','/s','/c',${JSON.stringify(windowsCommand)}],check=True,timeout=5)
except (OSError,subprocess.SubprocessError): print('WIN_DENIED')
else: sys.exit(94)
`
    const result = await execute("workspace-write", ["/usr/bin/python3", "-I", "-B", "-c", script])
    assert.equal(result.root.exitCode, 0)
    assert.ok(result.stdout.toString().includes("UNIX_DENIED") && result.stdout.toString().includes("WIN_DENIED"))
    assert.ok(!existsSync(escaped))
    return result.observed
  })
  await test("network cannot reach controlled external-namespace listener", async () => {
    const server = await listener()
    try {
      const connect = `import socket; s=socket.create_connection(('127.0.0.1',${server.port}),timeout=2); print('CONNECTED'); s.close()`
      const direct = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe"),
        ["--distribution", distribution, "--exec", "/usr/bin/python3", "-I", "-B", "-c", connect],
        { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] })
      direct.stdout.resume(); direct.stderr.resume()
      assert.equal(await new Promise<number | null>((yes, no) => { direct.once("error", no); direct.once("close", yes) }), 0)
      const result = await execute("read-only", ["/usr/bin/python3", "-I", "-B", "-c",
        `import socket,sys\ntry: socket.create_connection(('127.0.0.1',${server.port}),timeout=2)\nexcept OSError: print('NETWORK_DENIED')\nelse: sys.exit(95)`])
      assert.equal(result.root.exitCode, 0)
      assert.ok(result.stdout.toString().includes("NETWORK_DENIED"))
      return { port: server.port, positiveControl: "connected outside namespace", ...result.observed }
    } finally { await server.close() }
  })
  await test("cancel settles detached descendants", async () => {
    const execution = await launch("workspace-write", ["/usr/bin/bash", "--noprofile", "--norc", "-c",
      "/usr/bin/setsid /usr/bin/bash --noprofile --norc -c 'sleep 3; printf LATE > late-cancel.txt' & printf 'CANCEL_READY\\n'; wait"])
    const output = await collect(execution.handle, "CANCEL_READY")
    await output.ready
    const settled = await supervisor.cancel(execution.id, "cancelled")
    await output.drained
    assert.equal(settled.kind, "settled")
    await pause(3500)
    assert.ok(!existsSync(join(work, "late-cancel.txt")))
    assert.equal(supervisor.list().length, 0)
    return { receipt: execution.handle.receipt, settlement: settled, lateMarkerAbsent: true }
  })
  await test("root exit cleans detached descendants", async () => {
    const result = await execute("workspace-write", ["/usr/bin/bash", "--noprofile", "--norc", "-c",
      "/usr/bin/setsid /usr/bin/bash --noprofile --norc -c 'sleep 3; printf LATE > late-root.txt' </dev/null >/dev/null 2>&1 & printf 'ROOT_DONE\\n'; exit 0"])
    assert.equal(result.root.exitCode, 0)
    await pause(3500)
    assert.ok(!existsSync(join(work, "late-root.txt")))
    return { ...result.observed, lateMarkerAbsent: true }
  })
  await test("authority revocation drains active WSL execution", async () => {
    const execution = await launch("workspace-write", ["/usr/bin/bash", "--noprofile", "--norc", "-c",
      "printf 'REVOCATION_READY\\n'; sleep 3; printf LATE > late-revocation.txt"])
    const output = await collect(execution.handle, "REVOCATION_READY")
    await output.ready
    await supervisor.reconcile(execution.policy.owner.sessionId, () => { throw new Error("owned authority revoked") })
    await output.drained
    const settled = await execution.handle.settled
    assert.equal(settled.kind, "settled")
    await pause(3500)
    assert.ok(!existsSync(join(work, "late-revocation.txt")))
    assert.equal(supervisor.list().length, 0)
    return { receipt: execution.handle.receipt, settlement: settled, lateMarkerAbsent: true }
  })
  await test("changed directory identity refuses commit", async () => {
    const identityRoot = join(fixture, "identity-work")
    mkdirSync(identityRoot)
    const input = request("workspace-write", ["/usr/bin/bash", "--noprofile", "--norc", "-c", "printf WRONG > identity-escaped.txt"], identityRoot)
    const prepared = await backend.prepare(input.spec, input.policy, AbortSignal.timeout(20000))
    renameSync(identityRoot, identityRoot + "-old")
    mkdirSync(identityRoot)
    await assert.rejects(prepared.commit(() => {}))
    await prepared.rollback()
    assert.ok(!existsSync(join(identityRoot, "identity-escaped.txt")) && !existsSync(join(identityRoot + "-old", "identity-escaped.txt")))
    return { refusedBeforeWorkload: true }
  })
  await test("unsupported PTY and unrestricted modes refuse", async () => {
    const input = request("read-only", ["/usr/bin/bash", "--noprofile", "--norc", "-c", "printf WRONG > unsupported.txt"])
    await assert.rejects(backend.prepare({ ...input.spec, transport: "pty", pty: { cols: 80, rows: 24 } }, input.policy))
    const unrestricted = request("danger-full-access", input.spec.argv as string[])
    await assert.rejects(backend.prepare(unrestricted.spec, unrestricted.policy))
    assert.ok(!existsSync(join(work, "unsupported.txt")))
    return { refusedBeforeWorkload: true }
  })
  await test("pre-existing hardlink alias refuses writable admission", async () => {
    linkSync(join(reference, "kept.txt"), join(work, "reference-alias.txt"))
    const input = request("workspace-write", ["/usr/bin/bash", "--noprofile", "--norc", "-c", "printf WRONG > reference-alias.txt"])
    let prepared: Awaited<ReturnType<typeof backend.prepare>> | undefined
    await assert.rejects((async () => {
      prepared = await backend.prepare(input.spec, input.policy, AbortSignal.timeout(20000))
      await prepared.commit(() => {})
    })())
    await prepared?.rollback()
    assert.equal(readFileSync(join(reference, "kept.txt"), "utf8"), "REFERENCE_ORIGINAL")
    return { refusedBeforeWorkload: true, referenceContentsUnchanged: true }
  })
} catch (cause) {
  report.failure = cause instanceof Error ? cause.message : String(cause)
  report.failureDetails = errorDetails(cause)
  process.exitCode = 1
} finally {
  try { await supervisor.dispose(); await backend.dispose() }
  catch (cause) { report.failure ??= String(cause); process.exitCode = 1 }
  report.launcherDiagnostics = backend.diagnostics()
  save()
  process.stdout.write("Evidence: " + reportPath + "\n")
  if (report.failure) process.stderr.write(report.failure + "\n")
}
