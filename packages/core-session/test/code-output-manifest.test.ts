import { expect, it } from 'vitest'
import { validManagedArtifactRef } from '../src/results/validate.ts'
import { encodeCodeOutputRecord, decodeCodeOutputRecord } from '../src/results/code-output.ts'
it('accepts only the closed Code output manifest codec without reusing Exec dependencies', () => {
  const ref = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), contentDigest: 'c'.repeat(64), encodedBytes: 0, completeness: 'complete', codec: 'code-output-manifest-v1' }
  expect(validManagedArtifactRef(ref)).toBe(true)
  expect(validManagedArtifactRef({ ...ref, codec: 'code-output-any-v2' })).toBe(false)
})
it('requires canonical closed bounded UTF8 records without media bodies or hooks',()=>{
  const header={version:1 as const,kind:'code-output' as const,sessionId:'s',cellId:'c',sourceId:'original'}
  const bytes=encodeCodeOutputRecord(header)
  expect(decodeCodeOutputRecord(bytes)).toEqual(header)
  expect(()=>decodeCodeOutputRecord(Buffer.from(JSON.stringify(header)+'\n'))).toThrow('Noncanonical')
  expect(()=>decodeCodeOutputRecord(Buffer.alloc(65537,32))).toThrow('64KiB')
  expect(()=>decodeCodeOutputRecord(Buffer.from([255,10]))).toThrow()
  let hooks=0
  expect(()=>encodeCodeOutputRecord(Object.defineProperty({...header},'sessionId',{enumerable:true,get(){hooks++;return's'}}))).toThrow()
  expect(hooks).toBe(0)
  expect(()=>encodeCodeOutputRecord({...header,body:'raw media'} as never)).toThrow()
})
