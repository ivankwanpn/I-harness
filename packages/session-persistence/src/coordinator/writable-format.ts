import { CURRENT_FORMAT_VERSION } from "@i-harness/core-session"
import { preflightSessionFormat } from "../format/validation.ts"
import type { PersistenceBackend } from "./types.ts"

export function assertUpgradeCapability(backend: Pick<PersistenceBackend, "id" | "upgradeSessionFormat">, version: number): void {
  if (version < CURRENT_FORMAT_VERSION && !backend.upgradeSessionFormat) throw new Error(`session backend '${backend.id}' cannot upgrade writable session format`)
}
/** Gate is already held. Never calls coordinator flush/updateMeta (non-reentrant). */
export async function ensureWritableFormatUnlocked(backend: Pick<PersistenceBackend, "read" | "id" | "upgradeSessionFormat">, id: string): Promise<void> {
  const peeked = await backend.read(id)
  preflightSessionFormat(peeked.version, peeked.events)
  assertUpgradeCapability(backend, peeked.version)
  if (peeked.version < CURRENT_FORMAT_VERSION) {
    const meta = await backend.upgradeSessionFormat!(id, peeked.version, CURRENT_FORMAT_VERSION)
    if (meta.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error("session format upgrade did not establish writable header")
  }
}
