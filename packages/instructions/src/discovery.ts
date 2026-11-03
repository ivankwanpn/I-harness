import fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { InstructionConfigurationError, InstructionReadCleanupError, type InstructionScope, type InstructionTarget, type InstructionKind, type InstructionWatchInterest, type CandidatePresence } from './contracts.ts'

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const key = (path: string): string => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
export const inside = (root: string, path: string): boolean => { const r = relative(key(root), key(path)); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)) }
export const overlaps = (a: string, b: string): boolean => inside(a, b) || inside(b, a)
export function frozen<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) } return value }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InstructionConfigurationError('Expected a data record')
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new InstructionConfigurationError('Expected a plain data record')
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if (!('value' in d)) throw new InstructionConfigurationError('Accessors are not data')
  return value as Record<string, unknown>
}
export function absolute(value: unknown): string { if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new InstructionConfigurationError('Expected absolute path'); return normalize(value) }
export function paths(value: unknown): string[] { if (!Array.isArray(value)) throw new InstructionConfigurationError('Expected paths'); return [...new Map(value.map(p => { const n = absolute(p); return [key(n), n] })).values()] }
export function scopeData(value: unknown): InstructionScope {
  const r = record(value); const roots = paths(r.roots), globalSources = paths(r.globalSources)
  if (roots.length !== (r.roots as unknown[]).length || typeof r.enabled !== 'boolean' || !Number.isSafeInteger(r.maxBytes) || (r.maxBytes as number) < 0) throw new InstructionConfigurationError('Invalid roots, enabled or byte budget')
  if (globalSources.some(p => !['AGENTS.md', 'CLAUDE.md'].includes(basename(p)))) throw new InstructionConfigurationError('Invalid global filename')
  return frozen({ cwd: absolute(r.cwd), roots, globalSources, enabled: r.enabled, maxBytes: r.maxBytes as number })
}
export function targetData(value: unknown): InstructionTarget { const r = record(value); if (r.kind !== 'file' && r.kind !== 'directory') throw new InstructionConfigurationError('Invalid target kind'); return frozen({ path: absolute(r.path), kind: r.kind }) }
export const missing = (e: unknown): boolean => !!e && typeof e === 'object' && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
export async function canonical(path: string): Promise<string> {
  let current = path; const suffix: string[] = []
  for (let i = 0; i < 128; i++) {
    try { return join(await fs.realpath(current), ...suffix.reverse()) } catch (e) { if (!missing(e)) throw e }
    const parent = dirname(current); if (parent === current) break; suffix.push(basename(current)); current = parent
  }
  throw new Error('Canonical ancestor limit')
}
export interface TargetPlan { target: InstructionTarget; root?: string; directories: string[]; limited: boolean }
export interface DiscoveryPlan { targets: TargetPlan[]; globals: { directory: string; files: string[]; id: string }[]; globalLimited: boolean; interests: InstructionWatchInterest[] }
export function planDiscovery(scope: InstructionScope, targets: readonly InstructionTarget[]): DiscoveryPlan {
  const interests = new Map<string, InstructionWatchInterest>()
  const globals = new Map<string, { directory: string; files: string[]; id: string }>()
  for (const file of scope.globalSources) {
    const directory = dirname(file), id = key(directory); let group = globals.get(id)
    if (!group) { group = { directory, files: [], id }; globals.set(id, group) }
    group.files.push(file)
  }
  const boundedGlobals: DiscoveryPlan['globals'] = [], policySlots = new Set<string>(); let globalLimited = false
  for (const g of globals.values()) {
    if (policySlots.size + g.files.length > 256) { globalLimited = true; break }
    boundedGlobals.push(g)
    for (const file of g.files) policySlots.add(`global:${key(file)}`)
    interests.set(`global:${g.id}`, { directory: g.directory, candidates: g.files })
  }
  const plans = targets.map(target => {
    const root = scope.roots.filter(r => inside(r, target.path)).sort((a, b) => b.length - a.length)[0]
    const directories: string[] = []; let limited = false
    if (root) {
      let d = target.kind === 'file' ? dirname(target.path) : target.path
      while (inside(root, d)) {
        if (directories.length === 128) { limited = true; break }
        const localSlots = ['AGENTS.md', 'CLAUDE.md'].map(name => `local:${key(root)}:${key(join(d, name))}`)
        if (policySlots.size + localSlots.filter(id => !policySlots.has(id)).length > 256) { limited = true; break }
        localSlots.forEach(id => policySlots.add(id)); directories.push(d)
        interests.set(`local:${key(d)}`, { directory: d, candidates: [join(d, 'AGENTS.md'), join(d, 'CLAUDE.md'), join(d, '.git')] })
        if (key(d) === key(root)) break; d = dirname(d)
      }
    }
    return { target, root, directories, limited }
  })
  return { targets: plans, globals: boundedGlobals, globalLimited, interests: [...interests.values()] }
}
export interface BoundaryAlias { readonly lexical: string; readonly canonical: string }
export interface BoundaryResolution { readonly aliases: readonly BoundaryAlias[]; readonly unavailableTargets: readonly InstructionTarget[] }
export async function resolveBoundaryAliases(plan: DiscoveryPlan): Promise<BoundaryResolution> {
  const aliases = new Map<string, BoundaryAlias>()
  const unavailableTargets: InstructionTarget[] = []
  for (const target of plan.targets) {
    if (!target.root || target.limited) continue
    try {
      const root = await canonical(target.root)
      for (const directory of target.directories) {
        const resolved = await canonical(directory)
        if (!inside(root, resolved)) continue
        const lexical = join(directory, '.git')
        aliases.set(key(lexical), { lexical, canonical: join(resolved, '.git') })
      }
    } catch { unavailableTargets.push(target.target) }
  }
  return frozen({ aliases: [...aliases.values()], unavailableTargets })
}
export interface Slot { slotId: string; path: string; scopeRoot: string; scopeDirectory: string; kind: InstructionKind; presence: CandidatePresence; canonicalPath?: string; observedSize?: number; selected: boolean; outside: boolean; global: boolean }
export interface ResolverMembership {
  readonly root: string
  readonly target: string
  readonly selectedRoot: string
  readonly boundary: string
  readonly markers: readonly { readonly path: string; readonly canonicalPath: string; readonly state: 'absent' | 'valid' | 'invalid' }[]
  readonly globals: readonly string[]
}
export interface DiscoveredTarget { target: InstructionTarget; scopeKey: string; slotIds: string[]; complete: boolean; message?: string; membership?: ResolverMembership }
export interface Discovery { slots: Slot[]; targets: DiscoveredTarget[] }
async function gitMarker(directory: string): Promise<'absent' | 'valid' | 'invalid'> {
  const path = join(directory, '.git')
  let found = false
  try {
    const stat = await fs.stat(path)
    found = true
    if (stat.isDirectory()) return 'valid'
    if (!stat.isFile() || stat.size > 4096) return 'invalid'
    const handle = await fs.open(path, 'r')
    let readFailed = false, readError: unknown
    try {
      const buffer = Buffer.alloc(4096); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytesRead).toString('utf8'); const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text)
      if (!match) return 'invalid'
      return (await fs.stat(resolve(directory, match[1]))).isDirectory() ? 'valid' : 'invalid'
    } catch (error) { readFailed = true; readError = error; throw error }
    finally {
      try { await handle.close() }
      catch (error) { throw new InstructionReadCleanupError(readFailed ? new AggregateError([readError, error], 'Git marker read and cleanup failed') : error) }
    }
  } catch (e) { if (e instanceof InstructionReadCleanupError) throw e; return !found && missing(e) ? 'absent' : 'invalid' }
}
export async function discover(scope: InstructionScope, plan: DiscoveryPlan): Promise<Discovery> {
  const slots = new Map<string, Slot>(); const globalIds: string[] = []; let globalComplete = !plan.globalLimited
  async function group(root: string, dir: string, files: string[], global: boolean): Promise<string[] | undefined> {
    const ids = files.map(file => digest(['instruction-slot-v1', global ? 'global' : 'local', key(root), key(dir), basename(file)]))
    if (slots.size + ids.filter(id => !slots.has(id)).length > 256) return undefined
    const entries: Slot[] = []
    for (let i = 0; i < files.length; i++) {
      const path = files[i], slotId = ids[i]; let slot = slots.get(slotId)
      if (!slot) {
        slot = { slotId, path, scopeRoot: root, scopeDirectory: dir, kind: basename(path) as InstructionKind, presence: 'absent', selected: false, outside: false, global }
        try {
          const resolvedRoot = await canonical(root), resolved = await canonical(path)
          if (!inside(resolvedRoot, resolved)) { slot.outside = true; slot.presence = 'invalid' }
          else { slot.canonicalPath = resolved; const stat = await fs.stat(path); slot.canonicalPath = await fs.realpath(path); slot.observedSize = stat.size; slot.presence = stat.isFile() ? 'regular' : 'invalid' }
        } catch (e) { slot.presence = missing(e) ? 'absent' : 'unreadable' }
        slots.set(slotId, slot)
      }
      entries.push(slot)
    }
    const preferred = entries.find(s => s.kind === 'AGENTS.md' && s.presence !== 'absent') ?? entries.find(s => s.kind === 'CLAUDE.md' && s.presence !== 'absent')
    if (preferred) preferred.selected = true
    return ids
  }
  for (const g of plan.globals) { const ids = await group(g.directory, g.directory, [...g.files].sort((a, b) => basename(a).localeCompare(basename(b))), true); if (ids) globalIds.push(...ids); else { globalComplete = false; break } }
  const targets: DiscoveredTarget[] = []
  for (const p of plan.targets) {
    let complete = globalComplete && !p.limited; let boundary = p.root ?? ''; let message: string | undefined = globalComplete ? undefined : 'Instruction candidate limit reached'
    let rootCanonical: string | undefined, targetCanonical: string | undefined
    const markers: { path: string; canonicalPath: string; state: 'absent' | 'valid' | 'invalid' }[] = []
    let dirs: string[] = []
    if (p.limited) message = 'Instruction ancestor limit reached'
    else if (!p.root) { if (scope.roots.length) { complete = false; message = 'Target outside authorized roots' } }
    else {
      try {
        rootCanonical = await canonical(p.root); targetCanonical = await canonical(p.target.path)
        if (!inside(rootCanonical, targetCanonical)) { complete = false; message = 'Target canonical path outside authorized root' }
        else {
          for (const dir of p.directories) {
            const marker = await gitMarker(dir)
            const markerPath = join(dir, '.git')
            markers.push({ path: markerPath, canonicalPath: await canonical(markerPath), state: marker })
            if (marker === 'invalid') { complete = false; message = 'Invalid Git boundary'; dirs = []; break }
            dirs.push(dir)
            if (marker === 'valid') { boundary = dir; break }
          }
        }
      } catch (error) { if (error instanceof InstructionReadCleanupError) throw error; complete = false; message = 'Target boundary unavailable' }
    }
    const ids = [...globalIds]
    for (const dir of dirs.reverse()) { const next = await group(p.root!, dir, [join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md')], false); if (!next) { complete = false; message = 'Instruction candidate limit reached'; break } ids.push(...next) }
    const membership = rootCanonical && targetCanonical && p.root ? frozen({ root: rootCanonical, target: targetCanonical, selectedRoot: p.root, boundary, markers, globals: plan.globals.flatMap(g => g.files) }) : undefined
    targets.push({ target: p.target, scopeKey: digest(['instruction-scope-v1', p.root ? key(p.root) : null, key(boundary), plan.globals.map(g => [g.id, g.files.map(key)])]), slotIds: ids, complete, ...(message ? { message } : {}), ...(membership ? { membership } : {}) })
  }
  return { slots: [...slots.values()], targets }
}
