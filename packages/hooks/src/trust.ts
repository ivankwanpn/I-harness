import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { HookHandlerSpec } from "./types.ts"
import { HookTrustError } from "./types.ts"

/** sha256 of a file (the trust primitive). */
export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

/** The executed artifact a spec's trust hash is computed over. */
export function trustScriptPath(spec: HookHandlerSpec, configDir: string): string {
  const raw = spec.trust.script
  return isAbsolute(raw) ? raw : resolve(configDir, raw)
}

/**
 * Per-handler hash trust: recompute the artifact's sha256 and compare with
 * the recorded trust value. Throws HookTrustError on mismatch (fail-closed),
 * READONLY on ENOENT (unreadable artifact — caller wraps as a config error).
 */
export async function verifyHandlerTrust(
  spec: HookHandlerSpec,
  configDir: string,
): Promise<void> {
  const file = trustScriptPath(spec, configDir)
  const actual = await sha256File(file)
  if (actual !== spec.trust.sha256) {
    throw new HookTrustError(spec.id, spec.trust.sha256, actual)
  }
}
