import { expect, it } from 'vitest'
import * as persistence from '../src/index.ts'
import { exportConversationSeed, createSession, EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'

it('compiles none without source records using the shared literal empty digests', () => {
  expect((persistence as any).compileSemanticSeed({ kind: 'none' })).toEqual({
    digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST,
    sourceObservation: { kind: 'none' }, records: [],
  })
})
it('compiles a genuine semantic observation into addressed manifest records', () => {
  const exported = exportConversationSeed(createSession(), { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw new Error('Expected seed')
  const compiled = (persistence as any).compileSemanticSeed(exported)
  expect(compiled.records).toHaveLength(1)
  expect(compiled.records[0]).toMatchObject({ type: 'conversation/seed-manifest', seq: 0, digest: exported.digest })
  expect(compiled.sourceObservation).toEqual({ kind: 'semantic', digest: exported.sourceObservationDigest })
})
it('rejects accessor-bearing export wrappers before reading their discriminant',()=>{
  let reads=0
  const value=Object.defineProperty({},'kind',{enumerable:true,get(){reads++;return 'none'}})
  expect(()=>persistence.compileSemanticSeed(value as any)).toThrow()
  expect(reads).toBe(0)
})
