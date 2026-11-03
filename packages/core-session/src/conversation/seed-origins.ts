import type { SessionView } from '../managed/types.ts'
import type { SeedOrigin, SeedOriginAddress, SeedItem } from './seed-types.ts'
import type { CompletedPassiveContext } from './passive-seed-context.ts'
import { isOriginalCompletedPassiveContext } from './passive-seed-context.ts'
import type { HeldSelectedResults, SelectedResultRow } from './selected-results-types.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'
import { seedInvalid } from './seed-codec.ts'
import { copyConversationData } from './render.ts'

type Manifest = Extract<SessionView['events'][number], { type: 'conversation/seed-manifest' }>
/** The original normalization owner. Imported slot zero is historical. Local
 * zero never enters this descriptor map, even for the same session ID. */
export function createSeedOriginNormalizer() {
  const descriptors: SeedOrigin[] = [], keys = new Map<string, number>()
  let frozen: readonly SeedOrigin[] | undefined
  let slots: Map<number, number> | undefined
  const origin = (manifest: Manifest, old: number): number => {
    const descriptor = manifest.origins[old]
    if (!Number.isSafeInteger(old) || old < 0 || !descriptor) seedInvalid()
    const key = canonicalJsonData(descriptor)
    let slot = keys.get(key)
    if (slot === undefined) {
      if (frozen) seedInvalid()
      slot = descriptors.length + 1; keys.set(key, slot); descriptors.push(copyConversationData(descriptor))
    }
    return frozen ? slots!.get(slot)! : slot
  }
  const finalize = () => {
    if (!frozen) {
      const sorted = descriptors.map((descriptor, index) => ({ descriptor, old: index + 1, key: canonicalJsonData(descriptor) }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
      slots = new Map(sorted.map((entry, index) => [entry.old, index + 1]))
      frozen = Object.freeze(sorted.map(entry => Object.freeze(entry.descriptor)))
    }
    return frozen
  }
  const remap = (old: number): number => {
    if (old === 0) return 0
    if (!slots) seedInvalid()
    const slot = slots.get(old); if (slot === undefined) seedInvalid(); return slot
  }
  const inheritedOrigins = () => { if (!frozen) seedInvalid(); return frozen }
  return { origin, finalize, remap, inheritedOrigins }
}
export type SeedOriginNormalizer = ReturnType<typeof createSeedOriginNormalizer>

/** Enumerate typed provenance only; messages, args, media and inline values
 * are deliberately absent from this walk. */
export function itemOriginSlots(item: import('../managed/types.ts').DeepReadonly<SeedItem>): number[] {
  const slots = [...item.origins.map(a => a.origin), ...item.sourceProvenance.map(a => a.origin)]
  if (item.kind === 'input') slots.push(...item.input.raw.map(a => a.origin), ...item.input.derivedContext.map(a => a.origin))
  if (item.kind === 'exchange') {
    for (const call of item.calls) slots.push(...call.source.map(a => a.origin))
    for (const result of item.results) slots.push(...result.source.map(a => a.origin))
  }
  return slots
}
export function resultOriginAddresses(row: Pick<SelectedResultRow, 'basis' | 'branchEvidence'>): readonly SeedOriginAddress[] {
  const basis = row.basis
  return [...row.branchEvidence, ...(basis.kind === 'inherited' ? [] : [basis.unit.at, basis.unit.closedAt,
    ...(basis.kind === 'consumed-closed' ? [basis.consumedAt, basis.latestConsumption] : basis.kind === 'standalone-native' ? [basis.completedCell] : [])])]
}
export function mapResultOrigins<T extends Pick<SelectedResultRow, 'basis' | 'branchEvidence'>>(row: T, resolve: (slot: number) => number): T {
  const at = (address: SeedOriginAddress) => ({ ...address, origin: resolve(address.origin) })
  const basis = row.basis
  return { ...row, branchEvidence: row.branchEvidence.map(at), basis: basis.kind === 'inherited' ? basis : {
    ...basis, unit: { ...basis.unit, at: at(basis.unit.at), closedAt: at(basis.unit.closedAt) },
    ...(basis.kind === 'consumed-closed' ? { consumedAt: at(basis.consumedAt), latestConsumption: at(basis.latestConsumption) } : basis.kind === 'standalone-native' ? { completedCell: at(basis.completedCell) } : {}),
  } } as T
}
export function collectSelectedConversationOrigins(context: CompletedPassiveContext, normalizer: SeedOriginNormalizer): void {
  context.owner.assertCurrent()
  if (!isOriginalCompletedPassiveContext(context)) seedInvalid()
  const view = context.source.view, manifest = view.events[0]
  const add = (slot: number) => { if (manifest?.type !== 'conversation/seed-manifest') seedInvalid(); normalizer.origin(manifest, slot) }
  for (const { omission } of context.selected.inheritedOmissions) for (const address of omission.source) add(address.origin)
  for (const group of context.selected.groups) for (const descriptor of group.items) {
    const record = view.events[descriptor.establishmentIndex], recipe = descriptor.recipes.find(r => r.kind === 'seed-item')
    if (record?.type !== 'conversation/seed-group' || !recipe) continue
    const item = record.group.items[recipe.item!]; if (!item) seedInvalid()
    for (const slot of itemOriginSlots(item)) add(slot)
    if (item.kind === 'exchange') for (const result of item.results) if (result.kind === 'envelope') {
      const indices = [...(result.sourceRetention.kind === 'artifact' ? [result.sourceRetention.artifact] : []), ...(result.dependencies?.kind === 'catalog' ? [result.dependencies.artifact] : [])]
      for (const index of indices) {
        if (manifest?.type !== 'conversation/seed-manifest') seedInvalid()
        const artifact = manifest.artifacts[index]; if (!artifact) seedInvalid()
        for (const address of artifact.origins) add(address.origin)
      }
    }
  }
  context.owner.assertCurrent()
}
type HeldPlan = { context: CompletedPassiveContext; view: SessionView; selected: CompletedPassiveContext['selected']; normalizer: SeedOriginNormalizer; assertCurrent(): void; captured: boolean }
const heldPlans = new WeakMap<HeldSelectedResults, HeldPlan>()
export function registerSelectedOriginPlan(results: HeldSelectedResults, context: CompletedPassiveContext, normalizer: SeedOriginNormalizer): void {
  if (!isOriginalCompletedPassiveContext(context) || heldPlans.has(results)) seedInvalid()
  normalizer.inheritedOrigins(); results.assertCurrent()
  heldPlans.set(results, { context, view: context.source.view, selected: context.selected, normalizer, assertCurrent: results.assertCurrent, captured: false })
}
export function consumeSelectedOriginPlan(context: CompletedPassiveContext, results: HeldSelectedResults): SeedOriginNormalizer {
  const plan = heldPlans.get(results)
  if (!plan || plan.captured || plan.context !== context || plan.view !== context.source.view || plan.selected !== context.selected || !isOriginalCompletedPassiveContext(context)) seedInvalid()
  plan.assertCurrent(); plan.captured = true
  return plan.normalizer
}
