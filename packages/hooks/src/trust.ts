import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
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

/** One user-approved artifact. The KEY is the hash: approval is of CONTENT. */
export interface HookApproval {
  sha256: string
  script: string
  handlerId: string
  approvedAt: string
}

/** The user-layer grant set. */
export interface HookTrustStore {
  isApproved(sha256: string): boolean
  approve(entry: { sha256: string; script: string; handlerId: string }, now?: Date): void
  revoke(sha256: string): void
  list(): HookApproval[]
}

/** The user-layer approval file: `<configDir|$IH_CONFIG_DIR|~/.i-harness>/hook-trust.json`.
 * Resolved through `@i-harness/harness-home` — the one sanctioned home resolver
 * (`8c7d670a`), so this cannot drift from the other three chains that used to
 * disagree. */
export function resolveHookTrustPath(configDir?: string): string {
  return join(configDir ?? resolveHarnessHome(), "hook-trust.json")
}

/**
 * Every failure mode here lands on the SAME answer — an empty grant set — and
 * that is the point: an unreadable, absent or unshaped file approves nothing, so
 * a damaged store cannot accidentally widen what may run. Only `approve` and
 * `revoke` write, so a read never materialises the file.
 */
function loadApprovals(path: string): Map<string, HookApproval> {
  const out = new Map<string, HookApproval>()
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return out // absent → nothing is approved, and no file is created by reading
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    console.warn(`[hooks] trust store ${path} is not valid JSON; treating as NO approvals`)
    return out
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out
  const list = (raw as { approvals?: unknown }).approvals
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    // The hash is the KEY, and it is the only field that decides anything —
    // the rest is audit trail. A row without a usable hash approves nothing.
    if (typeof e.sha256 !== "string" || e.sha256 === "") continue
    out.set(e.sha256, {
      sha256: e.sha256,
      script: typeof e.script === "string" ? e.script : "",
      handlerId: typeof e.handlerId === "string" ? e.handlerId : "",
      approvedAt: typeof e.approvedAt === "string" ? e.approvedAt : "",
    })
  }
  return out
}

/**
 * The user-layer grant set: which artifact HASHES the user has approved.
 *
 * Keyed on the hash rather than on a handler id or a path, because approval is
 * of CONTENT — an id is chosen by the declaring layer and a path can be
 * repointed, so neither is an object worth trusting. A handler whose script is
 * byte-identical to an approved one is the approved one.
 *
 * This is deliberately NOT what `verifyHandlerTrust` does: that compares the
 * artifact against the hash the CONFIG declares, so a config naming its own
 * script satisfies it. **This store is the layer that decides whether the
 * declaration was ever granted.** Both checks run; they catch different lies.
 */
export function createHookTrustStore(path: string): HookTrustStore {
  const approvals = loadApprovals(path)
  const persist = (): void => {
    const body = { version: 1, approvals: [...approvals.values()] }
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  }
  return {
    isApproved: (sha256: string): boolean => approvals.has(sha256),
    approve(entry, now = new Date()): void {
      approvals.set(entry.sha256, {
        sha256: entry.sha256,
        script: entry.script,
        handlerId: entry.handlerId,
        approvedAt: now.toISOString(),
      })
      persist()
    },
    revoke(sha256: string): void {
      if (approvals.delete(sha256)) persist() // absent → no write, no throw
    },
    list: (): HookApproval[] => [...approvals.values()],
  }
}
