import { createHash, randomUUID } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { acquireSessionLock } from "@i-harness/fs-lock"

export const RESOURCE_BYTES = 131072
export const contentRevision = (body: string | Buffer) => createHash("sha256").update(body).digest("hex")
export function validateResourceName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) throw new Error("Invalid resource name; use lowercase kebab-case, up to 64 characters")
}
export function assertResourcePath(root: string, path: string): void {
  const child = relative(resolve(root), resolve(path))
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("Resource path is outside its source scope")
  let cursor = resolve(root)
  for (const part of ["", ...child.split(sep)]) {
    if (part) cursor = join(cursor, part)
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error("Resource symlink is outside the supported scope") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
}
export function readResourceFile(root: string, path: string): { body: string; revision: string } | undefined {
  assertResourcePath(root, path)
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.size > RESOURCE_BYTES) throw new Error("Resource must be a file of at most 128 KiB")
    const bytes = readFileSync(path)
    const body = bytes.toString("utf8")
    if (!Buffer.from(body, "utf8").equals(bytes)) throw new Error("Resource must contain valid UTF-8")
    return { body, revision: contentRevision(bytes) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}
export type ResourceFileResult = { kind: "saved"; revision: string } | { kind: "removed" } | { kind: "conflict"; currentRevision: string | null }
/** Shared process lock plus a last byte comparison. A conflict never consumes a renderer draft. */
export async function mutateResourceFile(root: string, path: string, expectedRevision: string | null, body?: string, validate?: (body: string) => Promise<void> | void): Promise<ResourceFileResult> {
  if (expectedRevision !== null && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))) throw new Error("expectedRevision must be a full content revision or null for create")
  assertResourcePath(root, path)
  await mkdir(root, { recursive: true })
  const lockPath = join(root, ".resource-authoring.lock")
  assertResourcePath(root, lockPath)
  const lock = await acquireSessionLock({ lockPath, deadlineMs: 10000 })
  let temporary: string | undefined
  try {
    const previous = readResourceFile(root, path)
    if ((previous?.revision ?? null) !== expectedRevision) return { kind: "conflict", currentRevision: previous?.revision ?? null }
    if (body === undefined) {
      if (!previous) throw new Error("Resource no longer exists")
      await rm(path)
      return { kind: "removed" }
    }
    if (typeof body !== "string") throw new Error("Resource body must be a string")
    // DOM textareas expose LF even for a CRLF source. Keep the source format
    // during a revision-checked edit, as the ordinary workspace editor does.
    if (previous?.body.includes("\r\n")) body = body.replace(/\r?\n/g, "\r\n")
    if (previous?.body.startsWith("\uFEFF") && !body.startsWith("\uFEFF")) body = `\uFEFF${body}`
    if (Buffer.byteLength(body, "utf8") > RESOURCE_BYTES) throw new Error("Resource body must be at most 128 KiB")
    await validate?.(body)
    assertResourcePath(root, path)
    await mkdir(dirname(path), { recursive: true })
    temporary = join(dirname(path), `.resource-${randomUUID()}.tmp`)
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx" })
    const current = readResourceFile(root, path)
    if ((current?.revision ?? null) !== expectedRevision) return { kind: "conflict", currentRevision: current?.revision ?? null }
    assertResourcePath(root, path)
    await rename(temporary, path); temporary = undefined
    return { kind: "saved", revision: contentRevision(body) }
  } finally { if (temporary) await rm(temporary, { force: true }); await lock.release() }
}
