import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { release as osRelease } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyHelper, type HelperOptions } from "./integrity.ts"

export type ObservedSupport = "observed-pass" | "unsupported"
export interface WindowsQualificationRecord {
  readonly recordVersion: 1
  readonly helperSha256: string
  readonly protocolSha256: string
  readonly windowsRelease: string
  readonly assurance: "experimental"
  readonly result: "incomplete"
  readonly observed: Readonly<{ passed: number; failed: number; unsupported: number }>
  readonly sourceFamilies: Readonly<Record<string, Readonly<{ psec: ObservedSupport; unrestricted: ObservedSupport }>>>
}
export interface WindowsQualificationView {
  /** Informational applicability only; never an admission or assurance decision. */
  readonly applicability: "matching-host" | "different-host" | "unavailable"
  readonly record: WindowsQualificationRecord
  readonly detail?: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function frozenRecord(value: unknown): WindowsQualificationRecord {
  const item = value as Record<string, any>
  if (!item || item.recordVersion !== 1 || item.assurance !== "experimental" || item.result !== "incomplete"
    || !/^[0-9a-f]{64}$/.test(item.helperSha256) || !/^[0-9a-f]{64}$/.test(item.protocolSha256)
    || typeof item.windowsRelease !== "string" || !item.observed || !item.sourceFamilies
    || item.sourceFamilies.gitMsysBash?.psec !== "unsupported") {
    throw new Error("Invalid shipped Windows qualification record")
  }
  const sourceFamilies = Object.freeze(Object.fromEntries(
    Object.entries(item.sourceFamilies).map(([name, status]) => [name, Object.freeze({ ...(status as object) })]),
  )) as WindowsQualificationRecord["sourceFamilies"]
  return Object.freeze({ ...item, observed: Object.freeze({ ...item.observed }), sourceFamilies }) as WindowsQualificationRecord
}

/** Read shipped observations and compare them with the selected helper and OS. No workload is started. */
export async function readWindowsQualification(options: HelperOptions = {}): Promise<WindowsQualificationView> {
  const record = frozenRecord(JSON.parse(await readFile(resolve(packageRoot, "qualification.json"), "utf8")))
  try {
    const helper = await verifyHelper(options)
    const protocolSha256 = sha256(await readFile(resolve(packageRoot, "protocol.md")))
    if (helper.sha256 !== record.helperSha256 || protocolSha256 !== record.protocolSha256) {
      return Object.freeze({ applicability: "unavailable", record, detail: "Shipped qualification identity differs from selected helper or protocol" })
    }
    return Object.freeze({ applicability: osRelease() === record.windowsRelease ? "matching-host" : "different-host", record })
  } catch (cause) {
    return Object.freeze({ applicability: "unavailable", record, detail: cause instanceof Error ? cause.message : String(cause) })
  }
}
