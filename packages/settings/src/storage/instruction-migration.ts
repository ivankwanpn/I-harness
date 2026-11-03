import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { assertInstructionData, normalizeInstructions, validInstructionSources } from "../instructions.ts"
import { isRecord } from "../normalize/primitives.ts"
import { normalizeSettings } from "../normalize/settings.ts"
import { parseDocumentTolerant } from "./json-patch.ts"

export interface LegacyInstructionImport {
  version: 1; profilePath: string; expectedDocumentHash: string; legacyHome: string; legacyWorkspace: string
}
export interface InstructionMigrationMeta {
  version: 1; mode: "native" | "legacy-explicit"; profilePath: string
  sourceHash?: string; globalSources?: string[]; legacyWorkspace?: string
}
export class InstructionMigrationError extends Error {
  constructor(readonly code: "invalid-request" | "invalid-metadata" | "ineligible" | "conflict" | "inapplicable" | "write-failed", message: string) {
    super(message)
    this.name = "InstructionMigrationError"
  }
}
export function instructionDocumentHash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}
const absolute = (v: unknown): v is string => typeof v === "string" && !v.includes("\0") && isAbsolute(v)
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f\d]{64}$/i.test(v)

export function instructionMigrationMeta(raw: Record<string, unknown>, profilePath: string): InstructionMigrationMeta | undefined {
  if (!Object.hasOwn(raw, "_instructionsMigration")) return undefined
  const meta = raw._instructionsMigration
  try { assertInstructionData(meta) } catch { throw new InstructionMigrationError("invalid-metadata", "instruction migration metadata must be plain data") }
  if (!isRecord(meta) || meta.version !== 1 || !["native", "legacy-explicit"].includes(meta.mode as string)
    || !absolute(meta.profilePath) || resolve(meta.profilePath) !== resolve(profilePath)
    || Object.keys(meta).some((key) => !["version", "mode", "profilePath", "sourceHash", "globalSources", "legacyWorkspace"].includes(key))
    || (meta.mode === "legacy-explicit" ? !hash(meta.sourceHash) || !validInstructionSources(meta.globalSources) || !absolute(meta.legacyWorkspace)
      : ["sourceHash", "globalSources", "legacyWorkspace"].some((key) => Object.hasOwn(meta, key)))) {
    throw new InstructionMigrationError("invalid-metadata", `invalid instruction migration metadata in ${profilePath}`)
  }
  return structuredClone(meta) as unknown as InstructionMigrationMeta
}

export function nativeInstructionMeta(profilePath: string): InstructionMigrationMeta {
  if (!absolute(profilePath)) throw new InstructionMigrationError("invalid-request", "settings profile must be absolute")
  return { version: 1, mode: "native", profilePath }
}

export function captureLegacyInstructionImport(request: LegacyInstructionImport, owningPath?: string): LegacyInstructionImport {
  try { assertInstructionData(request) } catch { throw new InstructionMigrationError("invalid-request", "import request must be plain data") }
  if (!isRecord(request) || request.version !== 1 || !absolute(request.profilePath) || !absolute(request.legacyHome)
    || !absolute(request.legacyWorkspace) || !hash(request.expectedDocumentHash)
    || (owningPath !== undefined && resolve(request.profilePath) !== resolve(owningPath))) {
    throw new InstructionMigrationError("invalid-request", "import must select the owning absolute profile, legacy home/workspace and a SHA256 preimage")
  }
  return structuredClone(request)
}

/** A recognized configured leaf must survive normalization unchanged. This
 * accepts existing settings vocabulary without using metadata as age evidence. */
function hasRecognizedSetting(raw: Record<string, unknown>): boolean {
  if (isRecord(raw.llm)) return true
  const saved = normalizeSettings(raw)
  function matchingLeaf(input: unknown, normalized: unknown): boolean {
    if (isRecord(input) && isRecord(normalized)) return Object.keys(input).some((key) => Object.hasOwn(normalized, key) && matchingLeaf(input[key], normalized[key]))
    if (Array.isArray(input) && Array.isArray(normalized)) return JSON.stringify(input) === JSON.stringify(normalized)
    return input === normalized && (typeof input === "boolean" || (typeof input === "number" && Number.isFinite(input)) || (typeof input === "string" && input.length > 0))
  }
  return Object.keys(saved).some((key) => key !== "onboarding" && Object.hasOwn(raw, key) && matchingLeaf(raw[key], saved[key as keyof typeof saved]))
}

/** Strict read is deliberately separate from the tolerant normal load fallback. */
export async function readInstructionImport(request: LegacyInstructionImport): Promise<{
  raw: Record<string, unknown>; text: string; replay: boolean; explicit: boolean
}> {
  let bytes: Buffer
  let raw: Record<string, unknown>
  try {
    bytes = await readFile(request.profilePath)
    raw = parseDocumentTolerant(bytes.toString("utf8"))
  } catch { throw new InstructionMigrationError("ineligible", "legacy import requires an existing, readable settings object") }
  const meta = instructionMigrationMeta(raw, request.profilePath)
  const explicit = isRecord(raw.instructions) && Object.hasOwn(raw.instructions, "globalSources")
  // A completed historical decision survives edits, reset, and stale preview digests.
  if (meta?.mode === "legacy-explicit") return { raw, text: bytes.toString("utf8"), replay: true, explicit }
  if (instructionDocumentHash(bytes) !== request.expectedDocumentHash.toLowerCase()) throw new InstructionMigrationError("conflict", "profile changed since legacy import preview")
  if (!hasRecognizedSetting(raw)) throw new InstructionMigrationError("ineligible", "profile must contain a valid recognized setting; metadata/onboarding alone is insufficient")
  return { raw, text: bytes.toString("utf8"), replay: false, explicit }
}

/** Old existence precedence includes empty/unreadable winners; never read rule bodies. */
function legacyWinners(request: LegacyInstructionImport): string[] {
  const winners = [join(request.legacyHome), join(request.legacyHome, ".claude")].flatMap((directory) => {
    const winner = [join(directory, "AGENTS.md"), join(directory, "CLAUDE.md")].find((path) => existsSync(path))
    return winner === undefined ? [] : [{ directory, path: winner }]
  })
  const selected = winners.filter(({ directory }) => {
    const rel = relative(directory, request.legacyWorkspace)
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  }).map(({ path }) => path) // home then .claude: broad to narrow when both are ancestors
  for (const { path } of winners) if (!selected.includes(path)) selected.unshift(path)
  return [...new Set(selected)]
}

export async function previewLegacyInstructionImport(input: LegacyInstructionImport): Promise<readonly string[]> {
  const request = captureLegacyInstructionImport(input)
  const state = await readInstructionImport(request)
  if (state.replay || state.explicit) throw new InstructionMigrationError("inapplicable", "legacy import is already completed or explicit globalSources is configured")
  return Object.freeze(legacyWinners(request))
}

/** Called only inside the owning store queue, after its profile selection check. */
export async function stageInstructionImport(request: LegacyInstructionImport): Promise<{
  raw: Record<string, unknown>; text: string; changed: boolean
}> {
  const state = await readInstructionImport(request)
  if (state.replay || state.explicit) return { ...state, changed: false }
  const globalSources = legacyWinners(request)
  return {
    text: state.text, changed: true,
    raw: { ...state.raw,
      instructions: { ...(isRecord(state.raw.instructions) ? state.raw.instructions : {}), ...normalizeInstructions(state.raw.instructions), globalSources },
      _instructionsMigration: { version: 1, mode: "legacy-explicit", profilePath: request.profilePath,
        sourceHash: request.expectedDocumentHash.toLowerCase(), globalSources, legacyWorkspace: request.legacyWorkspace } satisfies InstructionMigrationMeta,
    },
  }
}
