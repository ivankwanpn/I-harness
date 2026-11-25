import type { CompiledSandboxPolicy } from "./execution.ts"

export type PolicyPathSpellings = Readonly<Pick<CompiledSandboxPolicy, "primaryRoot" | "authorityRoots" | "referenceRoots">>

const spellings = new WeakMap<CompiledSandboxPolicy, PolicyPathSpellings>()
const usedByWsl = new WeakSet<CompiledSandboxPolicy>()

/** The compiler captures the original spelling alongside its comparison keys. */
export function associatePolicyPathSpellings(policy: CompiledSandboxPolicy, paths: PolicyPathSpellings): void {
  if (spellings.has(policy)) throw new TypeError("Execution policy paths already captured")
  spellings.set(policy, Object.freeze({
    primaryRoot: paths.primaryRoot,
    authorityRoots: Object.freeze([...new Set(paths.authorityRoots)].sort()),
    referenceRoots: Object.freeze([...new Set(paths.referenceRoots)].sort()),
  }))
}

export function policyPathSpellings(policy: CompiledSandboxPolicy): PolicyPathSpellings | undefined {
  return spellings.get(policy)
}

export function markWslPolicyPaths(policy: CompiledSandboxPolicy): void {
  if (!spellings.has(policy)) throw new TypeError("Original execution policy paths required")
  usedByWsl.add(policy)
}

export function usesWslPolicyPaths(policy: CompiledSandboxPolicy): boolean {
  return usedByWsl.has(policy)
}
