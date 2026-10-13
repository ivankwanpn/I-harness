import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { auditedGitBashShimSha256s } from "../src/git-bash-shim-manifest.ts"

export function msysPtyPrerequisite(shim: string, platform: NodeJS.Platform = process.platform, auditedSha256s: readonly string[] = auditedGitBashShimSha256s): { skip: boolean; reason?: string; sha256?: string } {
  if (platform !== "win32") return { skip: true, reason: "requires win32" }
  if (!existsSync(shim)) return { skip: true, reason: `Git Bash shim not found: ${shim}` }
  const sha256 = createHash("sha256").update(readFileSync(shim)).digest("hex")
  if (!auditedSha256s.includes(sha256)) return { skip: true, sha256,
    reason: `unaudited Git Bash shim ${shim}; observed SHA-256: ${sha256}; audited SHA-256 set: [${auditedSha256s.join(", ")}]` }
  return { skip: false, sha256 }
}
