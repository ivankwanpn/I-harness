import { realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import type { InstructionTarget } from '@i-harness/instructions'
export const contained = (root: string, path: string) => { const part = relative(resolve(root), resolve(path)); return part === '' || part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part) }
export const instructionTargetKey = (target: InstructionTarget) => {
  const lexical = resolve(target.path)
  return `${process.platform === 'win32' ? lexical.toLowerCase() : lexical}\0${target.kind}`
}
export const orderedInstructionTargets = (targets: ReadonlyMap<string, InstructionTarget>) => [...targets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, target]) => target)
export async function classifyInstructionTarget(target: InstructionTarget, roots: readonly string[]) {
  const root = roots.find(root => contained(root, target.path))
  if (!root) return { status: 'reference-only' as const, reason: 'outside-root' as const }
  try {
    const [mappedRoot, mapped] = await Promise.all([realpath(root), realpath(target.path)])
    if (!contained(mappedRoot, mapped)) return { status: 'reference-only' as const, reason: 'canonical-escape' as const }
    return { status: 'queued' as const }
  } catch { return { status: 'unavailable' as const, reason: 'mapping-unavailable' as const } }
}
