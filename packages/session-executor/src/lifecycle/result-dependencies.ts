import { isStrictFactData, validManagedArtifactRef, type ResultDependency, type ResultDependencyCatalog } from '@i-harness/core-session'
import { createResultCapture } from '@i-harness/output-retention'
import type { ResultArtifactSink } from '@i-harness/context-output'
import type { ResultFinalization, ToolResultDependency } from '@i-harness/core-tools'

function validDependency(value: ResultDependency, sourceId: string): boolean {
  if (!isStrictFactData(value) || value.kind !== 'exec-frames' || value.sourceId !== sourceId || Object.keys(value).some(key => !['kind', 'sourceId', 'retention'].includes(key))) return false
  const retained = value.retention
  if (retained.kind === 'artifact') return Object.keys(retained).every(key => ['kind', 'ref'].includes(key)) && validManagedArtifactRef(retained.ref) && retained.ref.codec === 'exec-frames-v1'
  return retained.kind === 'unavailable' && Object.keys(retained).every(key => ['kind', 'reason', 'observedEncodedBytes'].includes(key))
    && ['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(retained.reason)
    && (retained.observedEncodedBytes === undefined || Number.isSafeInteger(retained.observedEncodedBytes) && retained.observedEncodedBytes >= 0)
}

/** The catalog contains only private actual producer registrations, never
 * fields discovered in a return value or JSON-shaped reference. */
export function withResultDependencies(primary: ResultFinalization, sources: readonly ToolResultDependency[], openCatalog: () => Promise<ResultArtifactSink>): ResultFinalization {
  if (!sources.length) return primary
  let catalog: ResultFinalization | undefined, result: Awaited<ReturnType<ResultFinalization['settle']>> | undefined
  let running: Promise<Awaited<ReturnType<ResultFinalization['settle']>>> | undefined
  async function settle() {
    if (result) return result
    const value = await primary.settle()
    if (value.kind !== 'ready') return value
    if (!catalog) {
      const entries: ResultDependency[] = []
      for (const source of sources) {
        const retained = await source.settle()
        if (retained.kind !== 'ready' || !validDependency(retained.dependency, source.sourceId)) return { kind: 'recovery-required' as const }
        entries.push(structuredClone(retained.dependency))
      }
      const complete = entries.every(entry => entry.retention.kind === 'artifact' && entry.retention.ref.completeness === 'complete')
      const body: ResultDependencyCatalog = { version: 1, kind: 'result-dependencies', entries }
      catalog = createResultCapture(body, { outcome: 'succeeded', dispatch: 'not-dispatched' }, { openArtifact: openCatalog, forceArtifact: true, completeness: complete ? 'complete' : 'source-limited' })
    }
    const saved = await catalog.settle()
    if (saved.kind !== 'ready') return saved
    const retention = saved.envelope.retention
    if (retention.kind === 'inline') return { kind: 'recovery-required' as const }
    const dependencies = retention.kind === 'artifact' ? { kind: 'artifact-set' as const, ref: retention.ref, count: sources.length }
      : { kind: 'unavailable' as const, reason: retention.reason, count: sources.length }
    return result = { ...value, envelope: { ...value.envelope, dependencies } }
  }
  return { settle() {
    if (running) return running
    const next = settle(); running = next
    void next.finally(() => { if (running === next) running = undefined }).catch(() => {})
    return next
  } }
}
