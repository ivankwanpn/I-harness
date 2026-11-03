import { dirname, join, resolve } from 'node:path'
import type { InstructionScope, InstructionWatchInterest } from '../contracts.ts'
import { absolute, canonical, frozen, inside, key, paths, record } from '../discovery.ts'

export interface InterestPlan {
  readonly interests: readonly InstructionWatchInterest[]
  readonly aliases: readonly { lexical: string; canonical: string; directory: boolean }[]
  readonly selections: readonly (readonly string[])[]
  readonly signature: string
}

/** Only discovery-shaped local triples and explicitly configured global files
 * confer selection authority. Directory coverage is routing, not read authority. */
export function interestData(scope: InstructionScope, input: unknown): readonly InstructionWatchInterest[] {
  if (!Array.isArray(input) || input.length > 256) throw new Error('Invalid interest count')
  const result = new Map<string, InstructionWatchInterest>(), local = new Set<string>(), globals = new Set<string>()
  for (const value of input) {
    const data = record(value), directory = absolute(data.directory)
    if (!Array.isArray(data.candidates) || data.candidates.length > 256) throw new Error('Invalid candidates')
    const candidates = paths(data.candidates).sort()
    if (!candidates.length || candidates.length !== data.candidates.length || candidates.some(path => key(dirname(path)) !== key(directory))) throw new Error('Invalid interest shape')
    const triple = ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => key(join(directory, name)))
    if (candidates.length === 3 && triple.every(path => candidates.some(candidate => key(candidate) === path))) {
      if (!scope.roots.some(root => inside(root, directory))) throw new Error('Local interest outside scope')
      local.add(key(directory))
    } else {
      if (candidates.some(candidate => !scope.globalSources.some(global => key(global) === key(candidate)))) throw new Error('Unconfigured global interest')
      candidates.forEach(candidate => globals.add(key(candidate)))
    }
    result.set(JSON.stringify([key(directory), candidates.map(key)]), { directory, candidates })
  }
  // planDiscovery charges both slots BEFORE registering each local directory,
  // even above a later discovered Git boundary or on a subsequently limited target.
  // C+2L<=256, G<=C => C+G+4L<=512 lexical roots; aliases at most double that.
  if (globals.size + 2 * local.size > 256) throw new Error('Instruction interest capacity exceeded')
  return frozen([...result.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, interest]) => interest))
}

export async function resolveInterests(scope: InstructionScope, interests: readonly InstructionWatchInterest[]): Promise<InterestPlan> {
  const aliases = new Map<string, { lexical: string; canonical: string; directory: boolean }>()
  const resolved = new Map<string, Promise<string>>()
  const real = (path: string) => { let promise = resolved.get(key(path)); if (!promise) { promise = canonical(path); resolved.set(key(path), promise) } return promise }
  for (const interest of interests) {
    const local = interest.candidates.some(candidate => key(candidate) === key(join(interest.directory, '.git')))
    const root = local ? scope.roots.filter(root => inside(root, interest.directory)).sort((a, b) => b.length - a.length)[0] : interest.directory
    if (!root) throw new Error('Missing authorized root')
    const boundary = await real(root)
    for (const lexical of [interest.directory, ...interest.candidates]) {
      const mapped = await real(lexical)
      if (!inside(boundary, mapped)) throw new Error('Canonical interest outside authorized root')
      aliases.set(key(lexical), { lexical, canonical: mapped, directory: key(lexical) === key(interest.directory) })
    }
  }
  // Match W1 normalization exactly, including case-preserving roots and sorting.
  // No routing ancestors are added here; W1 is their sole owner.
  const roots = [...new Set([...aliases.values()].flatMap(alias => [alias.lexical, alias.canonical]).map(path => resolve(path.replace(/\\/g, '/'))))].sort()
  if (roots.length > 1024) throw new Error('Instruction selection capacity exceeded')
  const selections: string[][] = []
  for (let offset = 0; offset < roots.length; offset += 256) selections.push(roots.slice(offset, offset + 256))
  const data = [...aliases.values()].sort((a, b) => a.lexical.localeCompare(b.lexical))
  return frozen({ interests, aliases: data, selections, signature: JSON.stringify(data) })
}

/** Never canonicalize event or producer paths into new authority. Match against
 * the verified alias table; return lexical paths so absent slots are dirtied. */
export function matchPaths(plan: InterestPlan, changed: readonly string[], pending = false): { paths: string[]; mapping: boolean } {
  const matched = new Map<string, string>(); let mapping = false
  for (const raw of changed) {
    const path = absolute(raw)
    for (const alias of plan.aliases) {
      if (alias.directory) {
        if (!pending && (inside(path, alias.lexical) || inside(path, alias.canonical))) mapping = true
        continue
      }
      if ([alias.lexical, alias.canonical].some(candidate => inside(path, candidate) || key(path) === key(candidate))) {
        matched.set(key(alias.lexical), alias.lexical); matched.set(key(alias.canonical), alias.canonical)
      }
    }
  }
  return { paths: [...matched.values()].sort(), mapping }
}
