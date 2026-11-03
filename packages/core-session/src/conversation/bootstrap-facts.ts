import type { BootstrapInvocation } from '../events/bootstrap.ts'
import type { SeedSelection, SeedTurnDomain } from './seed-types.ts'
import { seedData, seedFields, seedCount, seedDigest, seedId, seedInvalid } from './seed-codec.ts'
import { freezeJsonData } from '../managed/capture.ts'
import { validateResultsSummary } from './selected-results-codec.ts'

export interface BootstrapPreparationFacts {
  version: 1; invocation: BootstrapInvocation; manifestDigest: string; seedDigest: string;
  sourceObservation: { kind: 'none' } | { kind: 'semantic'; digest: string };
  groupCount: number;
  semantic?: { selection: Exclude<SeedSelection, { kind: 'none' }>; turns: SeedTurnDomain };
}
export type SelectedResultsPreparationSemantic = { version: 3; profile: 'public-completed'; selection: import('./seed-types.ts').SemanticSeedV3Public['selection']; turns: SeedTurnDomain; results: import('./selected-results-types.ts').ResultsSummaryV1 }
  | { version: 3; profile: 'child-history'; selection: import('./seed-types.ts').SemanticSeedV3Child['selection']; turns: SeedTurnDomain; results: import('./selected-results-types.ts').ResultsSummaryV1 }
export interface BootstrapPreparationFactsV2 {
  version: 2; invocation: BootstrapInvocation; manifestDigest: string; seedDigest: string; dependencyDigest: string;
  sourceObservation: { kind: 'semantic'; digest: string }; seedLength: number; groupCount: number; resultPageCount: number;
  semantic: SelectedResultsPreparationSemantic;
}
export function captureSelectedResultsBootstrapPreparationFacts(value: unknown): BootstrapPreparationFactsV2 {
  seedData(value); seedFields(value, ['version', 'invocation', 'manifestDigest', 'seedDigest', 'dependencyDigest', 'sourceObservation', 'seedLength', 'groupCount', 'resultPageCount', 'semantic'])
  const facts = value as BootstrapPreparationFactsV2, semantic = facts.semantic
  seedFields(semantic, ['version', 'profile', 'selection', 'turns', 'results'])
  if (facts.version !== 2 || semantic.version !== 3 || !seedDigest(facts.dependencyDigest) || facts.sourceObservation.kind !== 'semantic'
    || !seedCount(facts.seedLength) || !seedCount(facts.resultPageCount) || !seedCount(facts.groupCount)
    || !Number.isSafeInteger(1 + facts.resultPageCount + facts.groupCount) || facts.seedLength !== 1 + facts.resultPageCount + facts.groupCount
    || (semantic.profile === 'public-completed' ? semantic.selection.kind !== 'completed' : semantic.profile !== 'child-history' || !['all', 'last-turns'].includes(semantic.selection.kind))) seedInvalid()
  validateResultsSummary(semantic.results)
  if (facts.resultPageCount !== semantic.results.pages) seedInvalid()
  captureBootstrapPreparationFacts({ version: 1, invocation: facts.invocation, manifestDigest: facts.manifestDigest, seedDigest: facts.seedDigest,
    sourceObservation: facts.sourceObservation, groupCount: facts.groupCount, semantic: { selection: semantic.selection, turns: semantic.turns } })
  return freezeJsonData(structuredClone(facts)) as BootstrapPreparationFactsV2
}
/** Own only metadata; callbacks never receive mutable coordinator arrays. */
export function captureBootstrapPreparationFacts(value: unknown): BootstrapPreparationFacts {
  seedData(value); seedFields(value, ['version', 'invocation', 'manifestDigest', 'seedDigest', 'sourceObservation', 'groupCount'], ['semantic'])
  const f = value as BootstrapPreparationFacts, i = f.invocation
  seedFields(i, ['version', 'operationId', 'targetSessionId', 'createdAt', 'requestDigest'])
  if (f.version !== 1 || i.version !== 1 || typeof i.operationId !== 'string' || !/^[\x21-\x7e]{1,237}$/.test(i.operationId) || !seedId(i.targetSessionId) || typeof i.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(i.createdAt) || !Number.isFinite(Date.parse(i.createdAt)) || new Date(i.createdAt).toISOString() !== i.createdAt || !seedDigest(i.requestDigest) || !seedDigest(f.manifestDigest) || !seedDigest(f.seedDigest) || !seedCount(f.groupCount)) seedInvalid()
  seedFields(f.sourceObservation, ['kind'], f.sourceObservation.kind === 'semantic' ? ['digest'] : [])
  if (f.sourceObservation.kind === 'none') { if (f.semantic !== undefined || f.groupCount !== 0) seedInvalid() }
  else {
    if (f.sourceObservation.kind !== 'semantic' || !seedDigest(f.sourceObservation.digest) || !f.semantic) seedInvalid()
    seedFields(f.semantic, ['selection', 'turns'])
    const { selection: s, turns: t } = f.semantic
    seedFields(s, ['kind'], s.kind === 'completed' ? ['atSeq'] : s.kind === 'last-turns' ? ['count'] : [])
    if (!['all', 'completed', 'last-turns'].includes(s.kind) || s.kind === 'completed' && s.atSeq !== undefined && !seedCount(s.atSeq) || s.kind === 'last-turns' && (!seedCount(s.count) || s.count === 0)) seedInvalid()
    seedFields(t, ['total', 'completed', 'unframedPrefix'])
    if (!seedCount(t.total) || typeof t.unframedPrefix !== 'boolean' || !Array.isArray(t.completed)) seedInvalid()
    let last = -1
    for (const range of t.completed) {
      if (!Array.isArray(range) || range.length !== 2 || !seedCount(range[0]) || !seedCount(range[1]) || range[0] < 1 || range[1] < range[0] || range[1] > t.total || range[0] <= last + 1) seedInvalid()
      last = range[1]
    }
  }
  return freezeJsonData(structuredClone(f)) as BootstrapPreparationFacts
}
