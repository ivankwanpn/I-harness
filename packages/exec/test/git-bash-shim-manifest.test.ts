import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { win32 } from "node:path"
import type { ProcessSpec } from "@i-harness/sandbox"

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const shims = [Buffer.from("audited launcher fixture one"), Buffer.from("audited launcher fixture two")]
const root = "C:\\git-shim-fixture", shim = win32.join(root, "bin", "bash.exe")
const executable = win32.join(root, "usr", "bin", "bash.exe"), runtime = win32.join(root, "usr", "bin", "msys-2.0.dll")
const configuration = win32.join(root, "etc", "git-bash.config"), runtimeBytes = Buffer.from("runtime fixture")

// Synthetic PE imports exercise recognition without qualifying a real binary.
function msysExecutable() {
  const bytes = Buffer.alloc(0x400), pe = 0x80, optional = pe + 24, section = optional + 0xf0
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(pe, 0x3c)
  bytes.writeUInt32LE(0x4550, pe); bytes.writeUInt16LE(0x8664, pe + 4)
  bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(0xf0, pe + 20)
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(0x1000, optional + 120); bytes.writeUInt32LE(40, optional + 124)
  bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(0x200, section + 16); bytes.writeUInt32LE(0x200, section + 20)
  bytes.writeUInt32LE(0x1030, 0x200 + 12); bytes.write("msys-2.0.dll\0", 0x230)
  return bytes
}

function spec(path = shim): ProcessSpec {
  return { argv: [path, "-i"], cwd: root, env: { HOME: "C:\\home", PATH: "caller-path", MSYS: "caller" },
    owner: { sessionId: "shim-fixture" }, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" }
}

async function resolver(bytes: Buffer, path = shim) {
  vi.resetModules()
  vi.doMock("../src/git-bash-shim-manifest.ts", () => ({ auditedGitBashShimSha256s: Object.freeze(shims.map(sha)) }))
  vi.doMock("node:fs", async () => ({
    ...await vi.importActual<typeof import("node:fs")>("node:fs"),
    realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
    readFileSync(pathToRead: string) {
      if (pathToRead === path) return bytes
      if (pathToRead === executable) return msysExecutable()
      if (pathToRead === runtime) return runtimeBytes
      if (pathToRead === configuration) return Buffer.from("MSYS=config\r\n")
      throw Object.assign(new Error("missing fixture file"), { code: "ENOENT" })
    },
    statSync: () => ({ isDirectory: () => true, isFile: () => true }),
  }))
  vi.stubGlobal("process", { ...process, platform: "win32" })
  return (await import("../src/windows-msys-pty.ts")).resolveWindowsMsysPty
}

afterEach(() => {
  vi.unstubAllGlobals(); vi.doUnmock("node:fs"); vi.doUnmock("../src/git-bash-shim-manifest.ts"); vi.resetModules()
})

describe("audited Git Bash shim manifest", () => {
  it("records audited identities in a frozen list that can grow", async () => {
    const { auditedGitBashShimSha256s } = await vi.importActual<typeof import("../src/git-bash-shim-manifest.ts")>("../src/git-bash-shim-manifest.ts")
    expect(Array.isArray(auditedGitBashShimSha256s)).toBe(true)
    expect(Object.isFrozen(auditedGitBashShimSha256s)).toBe(true)
    expect(auditedGitBashShimSha256s).toContain("9aa00217a92def5fed1b15c6e2b34a7f89e3781af822ecc00960fe5340df093e")
    expect(new Set(auditedGitBashShimSha256s).size).toBe(auditedGitBashShimSha256s.length)
    for (const hash of auditedGitBashShimSha256s) expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each(shims)("recognizes each manifest entry and pins its actual original identity: %s", async bytes => {
    const resolve = await resolver(bytes), original = spec(), resolved = resolve(original)
    expect(resolved.argv).toEqual([executable, "-i"])
    expect(resolved.cwd).toBe(original.cwd)
    expect(resolved.env).toEqual({ HOME: "C:\\home", PATH: `${win32.join(root, "mingw64", "bin")};${win32.dirname(executable)};C:\\home\\bin;caller-path`,
      MSYS: "config caller", EXEPATH: win32.dirname(shim), MSYSTEM: "MINGW64", PLINK_PROTOCOL: "ssh" })
    expect(resolved.msysPty).toEqual({ executable: { path: executable, sha256: sha(msysExecutable()) }, runtime: { path: runtime, sha256: sha(runtimeBytes) },
      resolution: { kind: "git-bash-shim", original: { path: shim, sha256: sha(bytes) }, configuration: { path: configuration, sha256: sha(Buffer.from("MSYS=config\r\n")) } } })
    expect(original.env).toEqual({ HOME: "C:\\home", PATH: "caller-path", MSYS: "caller" })
  })

  it.each(shims)("still refuses launcher controls for each audited identity: %s", async bytes => {
    const resolve = await resolver(bytes)
    expect(() => resolve({ ...spec(), argv: [shim, "--cd-to-home", "-i"] })).toThrow(/launcher option.*cannot be normalized/)
  })

  it("still pins a direct MSYS executable without changing argv or env", async () => {
    const resolve = await resolver(msysExecutable(), executable), original = spec(executable), resolved = resolve(original)
    expect(resolved.argv).toBe(original.argv)
    expect(resolved.env).toBe(original.env)
    expect(resolved.msysPty).toEqual({ executable: { path: executable, sha256: sha(msysExecutable()) }, runtime: { path: runtime, sha256: sha(runtimeBytes) } })
  })

  it("returns the identical spec on an unaudited shim miss", async () => {
    const resolve = await resolver(Buffer.from("unaudited launcher")), original = spec()
    expect(resolve(original)).toBe(original)
    expect(original.msysPty).toBeUndefined()
  })

  it("does not recognize audited bytes without the launcher layout", async () => {
    const path = win32.join(root, "bash.exe"), resolve = await resolver(shims[0]!, path), original = spec(path)
    expect(resolve(original)).toBe(original)
  })
})
