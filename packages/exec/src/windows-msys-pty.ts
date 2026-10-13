import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { win32 } from "node:path"
import type { ExecutionFileIdentity, ProcessSpec } from "@i-harness/sandbox"
import { auditedGitBashShimSha256s } from "./git-bash-shim-manifest.ts"

// Recognition is by audited bytes plus layout, never the name alone.
// Other versions retain their native path.
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex")
function file(path: string): Readonly<ExecutionFileIdentity> {
  const actual = realpathSync.native(path)
  if (!statSync(actual).isFile()) throw new Error(`MSYS PTY prerequisite is not a file: ${path}`)
  return { path: actual, sha256: sha(readFileSync(actual)) }
}

/** Inspect the PE import table; strings embedded in code are not imports. */
function importsMsys(bytes: Buffer): boolean {
  const available = (at: number, length: number) => Number.isSafeInteger(at) && at >= 0 && at + length <= bytes.length
  if (!available(0, 64) || bytes.readUInt16LE(0) !== 0x5a4d) return false
  const pe = bytes.readUInt32LE(0x3c)
  if (!available(pe, 24) || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) return false
  const optional = pe + 24, optionalSize = bytes.readUInt16LE(pe + 20), sections = bytes.readUInt16LE(pe + 6)
  if (optionalSize < 128 || !available(optional, optionalSize + sections * 40) || bytes.readUInt16LE(optional) !== 0x20b) return false
  const rva = (address: number): number | undefined => {
    for (let index = 0; index < sections; index++) {
      const section = optional + optionalSize + index * 40
      const start = bytes.readUInt32LE(section + 12), length = bytes.readUInt32LE(section + 16), offset = bytes.readUInt32LE(section + 20)
      if (address >= start && address - start < length && available(offset + address - start, 1)) return offset + address - start
    }
    return undefined
  }
  const table = rva(bytes.readUInt32LE(optional + 120)), size = bytes.readUInt32LE(optional + 124)
  if (table === undefined || size < 20) return false
  for (let offset = 0; offset + 20 <= size && available(table + offset, 20); offset += 20) {
    const descriptor = table + offset
    if (bytes.subarray(descriptor, descriptor + 20).every(value => value === 0)) break
    const name = rva(bytes.readUInt32LE(descriptor + 12))
    if (name === undefined) continue
    const end = bytes.indexOf(0, name)
    if (end >= name && end - name < 256 && bytes.toString("ascii", name, end).toLowerCase() === "msys-2.0.dll") return true
  }
  return false
}

function wrapperEnvironment(root: string, original: string, cwd: string, source: Readonly<Record<string, string>>, configuration: Buffer | undefined): Record<string, string> {
  const env = { ...source }
  const key = (name: string) => Object.keys(env).find(value => value.toLowerCase() === name.toLowerCase())
  const get = (name: string) => { const found = key(name); return found === undefined ? undefined : env[found] }
  const set = (name: string, value: string) => { env[key(name) ?? name] = value }
  set("EXEPATH", win32.dirname(original))
  set("MSYSTEM", "MINGW64")
  if (get("PLINK_PROTOCOL") === undefined) set("PLINK_PROTOCOL", "ssh")
  if (get("HOME") === undefined) {
    const candidate = (get("HOMEDRIVE") ?? "") + (get("HOMEPATH") ?? "")
    const system32 = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32")
    let usable = false
    try { usable = get("HOMEPATH") !== undefined && candidate.length > 0 && candidate.toLowerCase() !== system32.toLowerCase() && statSync(win32.resolve(cwd, candidate)).isDirectory() } catch { /* native wrapper falls back to USERPROFILE */ }
    if (usable) set("HOME", candidate)
    else if (get("USERPROFILE") !== undefined) set("HOME", get("USERPROFILE")!)
  }
  const home = get("HOME") ?? "", homeBin = home + (home.endsWith("\\") ? "" : "\\") + "bin;"
  const prefix = `${win32.join(root, "mingw64", "bin")};${win32.join(root, "usr", "bin")};`
  set("PATH", prefix + ((home ? home.length + 1 : 0) + 6 < 4096 ? homeBin : "") + (get("PATH") ?? ""))
  if (configuration !== undefined) {
    if (configuration.length > 1024 * 1024 || configuration.includes(0)) throw new Error("Git Bash PTY configuration cannot be normalized: oversized or NUL-containing git-bash.config")
    // The audited wrapper uses Windows text mode and fgets(1024), then handles
    // ASCII MSYS= entries in order. Other config lines do not affect launch.
    const text = configuration.toString("latin1").split("\x1a", 1)[0]!.replace(/\r\n/g, "\n")
    for (let offset = 0; offset < text.length;) {
      const newline = text.indexOf("\n", offset), end = Math.min(offset + 1023, newline < 0 ? text.length : newline + 1)
      let line = text.slice(offset, end); offset = end
      if (line.endsWith("\n")) line = line.slice(0, -1).replace(/\r$/, "")
      if (!line.startsWith("MSYS=")) continue
      if ([...line].some(char => char.charCodeAt(0) > 127)) throw new Error("Git Bash PTY configuration cannot be normalized: MSYS= values require the audited ASCII format")
      const value = line.slice(5), previous = get("MSYS")
      if (previous !== undefined && /[^\x00-\x7f]/.test(previous)) throw new Error("Git Bash PTY configuration cannot be normalized: prior MSYS must be ASCII when MSYS= applies because Windows ANSI conversion is unsupported; use ASCII MSYS or invoke actual usr/bin/bash.exe")
      set("MSYS", value + (previous !== undefined ? ` ${previous}` : ""))
    }
  }
  return env
}

/** Resolve before immutable admission; native prepare/commit pins every file. */
export function resolveWindowsMsysPty(spec: ProcessSpec): ProcessSpec {
  if (process.platform !== "win32" || spec.transport !== "pty" || spec.argumentEncoding !== "crt" || spec.executionTarget === "wsl") return spec
  let original: string, bytes: Buffer
  try { original = realpathSync.native(spec.argv[0]!); bytes = readFileSync(original) } catch { return spec }
  let executable = original, env = spec.env
  let resolution: NonNullable<ProcessSpec["msysPty"]>["resolution"]
  if (win32.basename(original).toLowerCase() === "bash.exe" && win32.basename(win32.dirname(original)).toLowerCase() === "bin" && auditedGitBashShimSha256s.includes(sha(bytes))) {
    const root = win32.dirname(win32.dirname(original))
    if (!statSync(win32.join(root, "mingw64", "bin")).isDirectory()) throw new Error("Recognized Git Bash PTY launcher has an unsupported installation layout")
    const first = spec.argv[1] ?? ""
    if (/^--(?:no-cd|cd-to-home|cd=|(?:no-)?minimal-search-path|(?:no-)?needs-console|(?:no-)?hide|(?:no-)?append-quote|command=|app-id=)/.test(first) || first === "gui") {
      throw new Error(`Git Bash PTY launcher option ${first} cannot be normalized; invoke the actual usr/bin/bash.exe with its own Bash arguments`)
    }
    const originalSha256 = sha(bytes)
    executable = realpathSync.native(win32.join(root, "usr", "bin", "bash.exe"))
    bytes = readFileSync(executable)
    if (!importsMsys(bytes)) throw new Error("Recognized Git Bash PTY launcher does not target an MSYS executable")
    const configurationPath = win32.join(root, "etc", "git-bash.config")
    let configuration: Buffer | undefined
    try { configuration = readFileSync(configurationPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    resolution = { kind: "git-bash-shim", original: { path: original, sha256: originalSha256 },
      configuration: { path: configurationPath, sha256: configuration === undefined ? null : sha(configuration) } }
    env = wrapperEnvironment(root, original, spec.cwd, env, configuration)
  } else if (!importsMsys(bytes)) return spec
  const runtime = file(win32.join(win32.dirname(executable), "msys-2.0.dll"))
  return { ...spec, argv: resolution === undefined ? spec.argv : [executable, ...spec.argv.slice(1)], env,
    msysPty: { executable: { path: resolution === undefined ? spec.argv[0]! : executable, sha256: sha(bytes) }, runtime, ...(resolution === undefined ? {} : { resolution }) },
  }
}
