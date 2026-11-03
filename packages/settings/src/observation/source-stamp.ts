import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"

export type SettingsSourceStamp = { kind: "present"; sha256: string } | { kind: "missing" } | { kind: "unreadable"; code: string }
export function stampBytes(bytes: Uint8Array): SettingsSourceStamp {
  return { kind: "present", sha256: createHash("sha256").update(bytes).digest("hex") }
}
function failureStamp(error: unknown): SettingsSourceStamp {
  const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN"
  return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable", code }
}
export async function readSourceStamp(path: string, onFailure?: (error: unknown) => void): Promise<SettingsSourceStamp> {
  try { return stampBytes(await readFile(path)) }
  catch (error) { onFailure?.(error); return failureStamp(error) }
}
export function readSourceStampSync(path: string): SettingsSourceStamp {
  try { return stampBytes(readFileSync(path)) } catch (error) { return failureStamp(error) }
}
export function sameSourceStamp(a: SettingsSourceStamp | undefined, b: SettingsSourceStamp | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
