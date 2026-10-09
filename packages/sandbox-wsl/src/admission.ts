import { statSync } from "node:fs"
import { win32 } from "node:path"
import { snapshotProcessSpec, type ProcessSpec, type CompiledSandboxPolicy } from "@i-harness/sandbox"

function within(path: string, root: string): boolean {
  const relative = win32.relative(root.toLowerCase(), path.toLowerCase())
  return relative === "" || (!relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative))
}
function directory(path: string): void {
  if (typeof path !== "string" || !/^[A-Za-z]:[\\/]/.test(path) || path.includes("\0") || /[<>:"|?*]/.test(path.slice(2)))
    throw new Error("WSL sandbox requires absolute local-drive Windows directories")
  if (path.split(/[\\/]/).some(part => part === "." || part === "..")) throw new Error("WSL sandbox rejects relative path components")
  if (!statSync(path).isDirectory()) throw new Error("WSL sandbox root must be a directory")
}

/** This function completes capture and admission synchronously, before inventory or guest startup. */
export function captureRequest(inputSpec: ProcessSpec, inputPolicy: CompiledSandboxPolicy): { spec: ProcessSpec; policy: CompiledSandboxPolicy } {
  const extra = inputPolicy as CompiledSandboxPolicy & { requireReadIsolation?: boolean; readIsolation?: boolean; denyPaths?: unknown }
  if (extra.requireReadIsolation || extra.readIsolation || extra.denyPaths !== undefined)
    throw new Error("WSL sandbox cannot provide read isolation or deny-path features")
  const spec = snapshotProcessSpec(inputSpec)
  const policy = Object.freeze({
    mode: inputPolicy.mode, owner: Object.freeze({ ...inputPolicy.owner }), authorityRevision: inputPolicy.authorityRevision,
    authorityKind: inputPolicy.authorityKind, primaryRoot: inputPolicy.primaryRoot, readable: inputPolicy.readable,
    authorityRoots: Object.freeze([...inputPolicy.authorityRoots]), writeRoots: Object.freeze([...inputPolicy.writeRoots]),
    referenceRoots: Object.freeze([...inputPolicy.referenceRoots]), fingerprint: inputPolicy.fingerprint,
  })
  if (spec.transport !== "pipe" || spec.lifetime !== "complete-tree" || spec.argumentEncoding !== "crt" || spec.pty !== undefined)
    throw new Error("WSL sandbox supports only pipes, complete-tree lifetime and Linux argv")
  if (!["read-only", "workspace-write", "danger-full-access"].includes(policy.mode)) throw new Error("Unsupported WSL sandbox mode")
  if (policy.mode === "danger-full-access" && policy.referenceRoots.length) throw new Error("WSL full access cannot protect reference roots")
  if (policy.readable !== "caller" || !["bound", "unbound"].includes(policy.authorityKind) || !policy.authorityRevision || !policy.fingerprint)
    throw new Error("Invalid WSL sandbox authority")
  if (!spec.owner.sessionId || spec.owner.sessionId !== policy.owner.sessionId || spec.owner.parentSessionId !== policy.owner.parentSessionId)
    throw new Error("WSL sandbox owner mismatch")
  if (!spec.argv.length || !/^\/(?!\/)/.test(spec.argv[0]!) || /\.exe$/i.test(spec.argv[0]!)
    || spec.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("WSL sandbox requires absolute Linux executable argv")
  for (const [key, value] of Object.entries(spec.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^WSL/i.test(key) || typeof value !== "string" || value.includes("\0"))
      throw new Error("Invalid or interop WSL sandbox environment")
  }
  for (const root of [spec.cwd, policy.primaryRoot, ...policy.authorityRoots, ...policy.writeRoots, ...policy.referenceRoots]) directory(root)
  if (!policy.authorityRoots.length || !policy.authorityRoots.some(root => within(spec.cwd, root))
    || !policy.authorityRoots.some(root => within(policy.primaryRoot, root))) throw new Error("WSL sandbox cwd/primary root is outside authority")
  if (policy.mode === "read-only" && policy.writeRoots.length) throw new Error("Read-only WSL sandbox cannot grant writes")
  for (const write of policy.writeRoots) {
    if (!policy.authorityRoots.some(root => within(write, root))) throw new Error("WSL write root is outside authority")
    if (policy.referenceRoots.some(root => within(write, root) || within(root, write))) throw new Error("WSL writable root overlaps a reference root")
  }
  return { spec, policy }
}

export function validDistribution(distribution: string): boolean {
  return typeof distribution === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(distribution) && distribution.trim() === distribution
}
export function decodeLauncherText(bytes: Buffer): string {
  return (bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("utf8")).replace(/^\uFEFF/, "")
}
export function parseWslInventory(bytes: Buffer, distribution: string): boolean {
  if (!validDistribution(distribution)) return false
  return decodeWslInventory(bytes).some(row => row.name === distribution && row.version === 2)
}
export function decodeWslInventory(bytes: Buffer): { name: string; version: number; state: string }[] {
  const rows = []
  for (const line of decodeLauncherText(bytes).split(/\r?\n/)) {
    const row = /^\s*\*?\s*(.*?)\s{2,}(\S+)\s+(\d+)\s*$/.exec(line)
    if (row && validDistribution(row[1]!) && ["1", "2"].includes(row[3]!)) rows.push({ name: row[1]!, version: Number(row[3]), state: row[2]! })
  }
  return rows
}
