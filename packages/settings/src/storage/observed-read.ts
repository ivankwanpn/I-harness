import { readFile } from "node:fs/promises"
import { normalizeInstructions, validateInstructions } from "../instructions.ts"
import { isRecord } from "../normalize/primitives.ts"
import { stampBytes } from "../observation/source-stamp.ts"
import type { ObservedSettingsLoad, ObservedSettingsLoadOptions } from "./contracts.ts"
import { instructionMigrationMeta } from "./instruction-migration.ts"
import { parseDocumentTolerant } from "./json-patch.ts"

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return
  for (const child of Object.values(value)) freezeJson(child)
  Object.freeze(value)
}

/** Stateless strict read. Parsing, validation and attestation share one buffer. */
export async function readObservedDocument(filename: string, validate: ObservedSettingsLoadOptions["validate"]): Promise<{
  raw: Record<string, unknown>; stamp: Extract<ObservedSettingsLoad, { kind: "loaded" }>["stamp"]
} | undefined> {
  let bytes: Buffer
  try { bytes = await readFile(filename) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
    throw new Error("invalid settings: cannot read document")
  }
  let raw: Record<string, unknown>
  try { raw = parseDocumentTolerant(bytes.toString("utf8")) }
  catch { throw new Error("invalid settings: expected a valid document object") }
  if (Object.hasOwn(raw, "instructions")) {
    if (!isRecord(raw.instructions)) throw new Error("instructions: expected object")
    // Default only absent fields; supplied values must survive strict validation.
    validateInstructions({ ...normalizeInstructions(undefined), ...raw.instructions })
  }
  instructionMigrationMeta(raw, filename)
  if (validate !== undefined) {
    const isolated = structuredClone(raw)
    freezeJson(isolated)
    try { validate(isolated) }
    catch { throw new Error("invalid settings: document validation failed") }
  }
  // stampBytes always returns the present variant for an already captured buffer.
  const stamp = stampBytes(bytes) as Extract<ObservedSettingsLoad, { kind: "loaded" }>["stamp"]
  return { raw, stamp }
}
