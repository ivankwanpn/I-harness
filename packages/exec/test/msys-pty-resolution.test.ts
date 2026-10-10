import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs"
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve, win32 } from "node:path"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import type { ProcessSpec, TransportExecutionBackend } from "@i-harness/sandbox"
import { createExecService } from "../src/index.ts"
import { createTerminalService } from "../../terminal/src/service.ts"
import { createTerminalTools } from "../../terminal/src/tool.ts"
import { createWindowsUnrestrictedBackend } from "../../sandbox-windows-psec/src/index.ts"
import type { ToolExec } from "../../core-tools/src/index.ts"

const git = win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git")
const installedShim = win32.join(git, "bin", "bash.exe")
const installedBash = win32.join(git, "usr", "bin", "bash.exe")
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

async function nativeControl(argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<Buffer> {
  const backend = createWindowsUnrestrictedBackend(), owner = { sessionId: "native-resolution-control" }
  const policy = compileExecutionPolicy({ mode: "danger-full-access", owner, authority: { kind: "unbound", revision: "control-1", workspaceRoot: cwd } })
  try {
    const prepared = await backend.prepare({ argv, cwd, env, owner, transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" }, policy)
    const handle = await prepared.commit(() => {})
    const chunks: Buffer[] = []
    const output = (async () => { for await (const frame of handle.io.output) if (frame.channel === "stdout") chunks.push(Buffer.from(frame.data)) })()
    await handle.io.endInput()
    const settlement = await handle.settled
    await output
    expect(settlement).toMatchObject({ kind: "settled", root: { exitCode: 0 } })
    return Buffer.concat(chunks)
  } finally { await backend.dispose() }
}

async function layout(config?: string) {
  mkdirSync(resolve(".tmp"), { recursive: true })
  const root = await mkdtemp(resolve(".tmp/msys-pty-resolution-")); roots.push(root)
  for (const dir of ["bin", "usr", "mingw64", "etc", "home"]) mkdirSync(join(root, dir))
  const shim = join(root, "bin", "bash.exe")
  await copyFile(installedShim, shim)
  symlinkSync(win32.join(git, "usr", "bin"), join(root, "usr", "bin"), "junction")
  symlinkSync(win32.join(git, "mingw64", "bin"), join(root, "mingw64", "bin"), "junction")
  const configuration = join(root, "etc", "git-bash.config")
  if (config !== undefined) await writeFile(configuration, config)
  return { root, shim, configuration }
}

function fixture(root: string, probeGate?: Promise<void>) {
  const selected: ProcessSpec[] = [], prepared: ProcessSpec[] = []
  const backend: TransportExecutionBackend = {
    async probe() { await probeGate; return { id: "resolution-fixture", availability: "available", assurance: "unverified", features: {
      writeIsolation: true, readIsolation: false, denyPaths: false, pipes: true, pty: true, retainedTree: true } } },
    async prepare(spec) { prepared.push(spec); throw new Error("captured pre-admission request") },
  }
  const service = createExecService({ workspaceRoot: root, execution: {
    defaultOwner: { sessionId: "resolution-owner" }, selectBackend(_policy, _transport, spec) { selected.push(spec!); return backend },
    resolvePolicy(owner, requested) { return compileExecutionPolicy({ owner, mode: requested?.mode ?? "danger-full-access", authority: { kind: "unbound", revision: "1", workspaceRoot: root } }) },
    validateAuthority() {},
  } })
  return { service, selected, prepared }
}

describe.skipIf(process.platform !== "win32" || !existsSync(installedShim))("pre-admission MSYS PTY identity", () => {
  it.each([undefined, "MSYS=first\r\nignored=value\r\nMSYS=last\r\n"])("normalizes only the audited shim and preserves its actual environment/argv/cwd with config %s", async config => {
    const f = await layout(config), { service, selected } = fixture(f.root)
    const env = { PaTh: win32.dirname(process.execPath), HoMe: join(f.root, "home"), Plink_Protocol: "", mSyS: "caller", EMPTY: "", PAYLOAD: "雪 spaces", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
    const command = 'printf "%s\\0" "$MSYSTEM" "$EXEPATH" "$PATH" "$HOME" "$PLINK_PROTOCOL" "$MSYS" "$EMPTY" "$PAYLOAD"; pwd -W; printf "%s\\0" "$@"'
    const tail = ["--noprofile", "--norc", "-c", command, "capture", "two words", '"quoted"', "back\\slash", "雪"]
    try {
      await expect(service.launchTransport({ argv: [f.shim, ...tail], cwd: f.root, env, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt", pty: { cols: 90, rows: 31 } })).rejects.toThrow("captured pre-admission")
      const spec = selected[0]!
      expect(spec.argv).toEqual([realpathSync.native(installedBash), ...tail])
      expect(spec.cwd).toBe(f.root)
      expect(spec.pty).toEqual({ cols: 90, rows: 31 })
      expect(spec.env).toMatchObject({ PaTh: expect.any(String), HoMe: env.HoMe, EMPTY: "", PAYLOAD: "雪 spaces" })
      expect(spec.msysPty).toEqual({ executable: { path: realpathSync.native(installedBash), sha256: sha(installedBash) },
        runtime: { path: realpathSync.native(win32.join(git, "usr", "bin", "msys-2.0.dll")), sha256: sha(win32.join(git, "usr", "bin", "msys-2.0.dll")) },
        resolution: { kind: "git-bash-shim", original: { path: realpathSync.native(f.shim), sha256: "9aa00217a92def5fed1b15c6e2b34a7f89e3781af822ecc00960fe5340df093e" },
          configuration: { path: f.configuration, sha256: config === undefined ? null : sha(f.configuration) } } })
      expect(spec.env.Plink_Protocol).toBe("")
      const native = await nativeControl([f.shim, ...tail], f.root, env)
      const resolved = await nativeControl(spec.argv, spec.cwd, spec.env)
      expect(resolved).toEqual(native)
    } finally { await service.dispose() }
  })

  it("captures direct MSYS executable/runtime identity without changing its arguments or explicit empty environment", async () => {
    const { service, selected } = fixture(process.cwd())
    try {
      await expect(service.launchTransport({ argv: [installedBash, "-c", "true"], cwd: process.cwd(), env: {}, transport: "pty", lifetime: "complete-tree", argumentEncoding: "crt", pty: { cols: 80, rows: 24 } })).rejects.toThrow("captured pre-admission")
      expect(selected[0]).toMatchObject({ argv: [installedBash, "-c", "true"], env: {}, msysPty: { executable: { path: installedBash, sha256: sha(installedBash) } } })
      expect(selected[0]!.msysPty!.resolution).toBeUndefined()
    } finally { await service.dispose() }
  })

  it("keeps a direct MSYS executable alias in argv while the native owner can canonicalize its pinned identity", async () => {
    const f = await layout(), alias = join(f.root, "usr", "bin", "bash.exe"), { service, selected } = fixture(f.root)
    try {
      await expect(service.launchTransport({ argv: [alias, "-i"], cwd: f.root, env: {}, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" })).rejects.toThrow("captured pre-admission")
      expect(selected[0]).toMatchObject({ argv: [alias, "-i"], env: {}, msysPty: { executable: { path: alias, sha256: sha(installedBash) } } })
      expect(selected[0]!.msysPty!.resolution).toBeUndefined()
    } finally { await service.dispose() }
  })

  it.each(["profile fallback", "drive/path fallback", "empty environment", "explicit empty HOME", "empty HOME candidate"] as const)("matches the real audited launcher environment under %s", async mode => {
    const f = await layout(mode === "explicit empty HOME" ? "MSYS=config\r\n" : undefined), { service, selected } = fixture(f.root), home = join(f.root, "home")
    const env = mode === "empty environment" ? {} : { PATH: "", USERPROFILE: home,
      ...(mode === "explicit empty HOME" ? { HOME: "", PLINK_PROTOCOL: "", MSYS: "" } : {}),
      ...(mode === "drive/path fallback" ? { HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) } : mode === "empty HOME candidate" ? { HOMEDRIVE: "", HOMEPATH: "" } : { HOMEDRIVE: "C:", HOMEPATH: "\\IH_DOES_NOT_EXIST_pty_capture" }) }
    const tail = ["--noprofile", "--norc", "-c", 'printf "%s\\0" "$MSYSTEM" "$EXEPATH" "$PATH" "$HOME" "$PLINK_PROTOCOL"']
    try {
      await expect(service.launchTransport({ argv: [f.shim, ...tail], cwd: f.root, env, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" })).rejects.toThrow("captured pre-admission")
      const spec = selected[0]!
      if (mode === "explicit empty HOME") expect(spec.env).toMatchObject({ HOME: "", PLINK_PROTOCOL: "", MSYS: "config " })
      expect((await nativeControl(spec.argv, f.root, spec.env)).toString("utf8").split("\0")).toEqual((await nativeControl([f.shim, ...tail], f.root, env)).toString("utf8").split("\0"))
    } finally { await service.dispose() }
  })

  it.each(["--cd-to-home", "--minimal-search-path", "--command=changed"])("refuses launcher control %s before native admission instead of changing the request", async option => {
    const f = await layout(), { service, selected } = fixture(f.root)
    try {
      await expect(service.launchTransport({ argv: [f.shim, option, "-i"], cwd: f.root, env: {}, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" })).rejects.toThrow(/launcher option.*cannot be normalized/)
      expect(selected).toEqual([])
    } finally { await service.dispose() }
  })

  it.each(["relative", "drive relative"] as const)("checks a %s HOME candidate against the actual child working directory", async mode => {
    const f = await layout(), { service, selected } = fixture(f.root)
    const env = { HOMEDRIVE: mode === "relative" ? "" : f.root.slice(0, 2), HOMEPATH: "home", USERPROFILE: "C:\\review-fallback-home", PATH: "" }
    const tail = ["--noprofile", "--norc", "-c", 'printf "%s\\0" "$HOME" "$PATH"']
    try {
      await expect(service.launchTransport({ argv: [f.shim, ...tail], cwd: f.root, env, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" })).rejects.toThrow("captured pre-admission")
      const spec = selected[0]!
      const original = (await nativeControl([f.shim, ...tail], f.root, env)).toString("utf8").split("\0")
      const normalized = (await nativeControl(spec.argv, spec.cwd, spec.env)).toString("utf8").split("\0")
      expect(original[0]).toMatch(/\/home$/)
      expect(normalized).toEqual(original)
      expect(spec.env.HOME).toBe(env.HOMEDRIVE + env.HOMEPATH)
    } finally { await service.dispose() }
  })

  it("diagnoses a non-ASCII prior MSYS before admission when an ASCII config directive would use Windows ANSI conversion", async () => {
    const f = await layout("MSYS=config\r\n"), { service, selected } = fixture(f.root)
    const env = { HOME: join(f.root, "home"), MSYS: "雪 café", PATH: "" }
    const tail = ["--noprofile", "--norc", "-c", 'printf "%s\\0" "$MSYS"']
    try {
      // Exercise the original launcher with an exact native environment. Its
      // locale-dependent ANSI conversion cannot be faithfully guessed in JS.
      const original = (await nativeControl([f.shim, ...tail], f.root, env)).toString("utf8").split("\0")
      expect(original[0]).toMatch(/^config /)
      await expect(service.launchTransport({ argv: [f.shim, ...tail], cwd: f.root, env, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" })).rejects.toThrow(/prior MSYS.*ASCII.*ANSI/)
      expect(selected).toEqual([])
    } finally { await service.dispose() }
  })

  it.each([undefined, "unrelated=value\r\n"])("preserves a non-ASCII MSYS value when config %s has no applicable MSYS directive", async config => {
    const f = await layout(config), { service, selected } = fixture(f.root)
    const env = { HOME: join(f.root, "home"), MSYS: "雪 café", PATH: "" }
    const tail = ["--noprofile", "--norc", "-c", 'printf "%s\\0" "$MSYS"']
    try {
      await expect(service.launchTransport({ argv: [f.shim, ...tail], cwd: f.root, env, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" })).rejects.toThrow("captured pre-admission")
      const spec = selected[0]!
      expect(spec.env.MSYS).toBe("雪 café")
      expect(await nativeControl(spec.argv, spec.cwd, spec.env)).toEqual(await nativeControl([f.shim, ...tail], f.root, env))
    } finally { await service.dispose() }
  })

  it("the original public terminal_open tool reaches the normalized immutable process request", async () => {
    const { service, selected } = fixture(process.cwd()), terminal = createTerminalService(service)
    try {
      const tool = createTerminalTools({ service: terminal }).find(tool => tool.name === "terminal_open")!
      await expect(tool.execute({ command: installedShim, args: ["--noprofile", "--norc", "-i"], cols: 100, rows: 24 }, { sessionId: "resolution-owner" } as ToolExec)).rejects.toThrow("captured pre-admission")
      expect(selected[0]).toMatchObject({ argv: [installedBash, "--noprofile", "--norc", "-i"], owner: { sessionId: "resolution-owner" }, msysPty: { resolution: { kind: "git-bash-shim" } } })
      expect(Object.isFrozen(selected[0]!.msysPty!.resolution)).toBe(true)
    } finally { await terminal.dispose(); await service.dispose() }
  })

  it("captures all resolution observations before an awaiting probe even if the caller mutates argv, env, cwd and configuration", async () => {
    const f = await layout(), gate = Promise.withResolvers<void>(), { service, selected, prepared } = fixture(f.root, gate.promise)
    const argv = [f.shim, "-i"], env = { PATH: "original", HOME: join(f.root, "home"), EMPTY: "" }
    const request = { argv, env, cwd: f.root, transport: "pty" as const, lifetime: "retain-tree" as const, argumentEncoding: "crt" as const, pty: { cols: 80, rows: 24 } }
    const pending = service.launchTransport(request)
    argv[0] = "C:\\changed.exe"; env.HOME = "changed"; request.cwd = "C:\\changed"
    await writeFile(f.configuration, "MSYS=created-after-capture")
    gate.resolve()
    try {
      await expect(pending).rejects.toThrow("captured pre-admission")
      expect(prepared[0]).toEqual(selected[0])
      expect(prepared[0]).toMatchObject({ argv: [installedBash, "-i"], cwd: f.root, env: { HOME: join(f.root, "home"), EMPTY: "" }, msysPty: { resolution: { configuration: { path: f.configuration, sha256: null } } } })
    } finally { gate.resolve(); await service.dispose() }
  })

  it.each(["unknown bytes", "pipe", "wsl"] as const)("keeps original execution behavior for %s instead of a name-only rewrite", async mode => {
    const f = await layout(), { service, selected } = fixture(f.root)
    if (mode === "unknown bytes") await writeFile(f.shim, Buffer.concat([readFileSync(f.shim), Buffer.from("customized msys-2.0.dll")]))
    try {
      await expect(service.launchTransport({ argv: [f.shim, "-i"], cwd: f.root, env: {}, transport: mode === "pipe" ? "pipe" : "pty", lifetime: "retain-tree", argumentEncoding: "crt", ...(mode === "wsl" ? { executionTarget: "wsl" as const } : {}) })).rejects.toThrow("captured pre-admission")
      expect(selected[0]!.argv).toEqual([f.shim, "-i"])
      expect(selected[0]!.msysPty).toBeUndefined()
    } finally { await service.dispose() }
  })
})
