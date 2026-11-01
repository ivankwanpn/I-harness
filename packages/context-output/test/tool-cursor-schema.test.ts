import { expect, it } from 'vitest'
import { join } from 'node:path'
import { createContext } from '../../core-plugin/src/index.ts'
import { createToolRegistry, validateJsonSchemaValue, type JsonSchemaNode } from '@i-harness/core-tools'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { createContextOutputService } from '../src/service.ts'
import { createContextOutputTools } from '../src/tools.ts'
import { parseResultPageQuery } from '../src/result-page.ts'

const ref = (codec: ManagedArtifactRef['codec']): ManagedArtifactRef => ({
  version: 1, id: `ctxv1_${'a'.repeat(64)}`, revision: 'b'.repeat(64), codec,
  encodedBytes: 256, contentDigest: 'c'.repeat(64), completeness: 'complete',
})

it('registers Context Output cursors through the original tool schema subset', async () => {
  const service = createContextOutputService({ root: join(process.env.IH_CONFIG_DIR!, 'schema'), workspaceId: 'w' })
  try {
    const registry = createToolRegistry(createContext())
    for (const tool of createContextOutputTools(service)) expect(() => registry.register(tool)).not.toThrow()
  } finally { await service.close() }
})

it('keeps both cursor shapes while the original codec boundary rejects mixed and incomplete cursors', async () => {
  const service = createContextOutputService({ root: join(process.env.IH_CONFIG_DIR!, 'cursor-shapes'), workspaceId: 'w' })
  try {
    const tool = createContextOutputTools(service).find(tool => tool.name === 'context_output_read')!
    const schema = tool.inputSchema as JsonSchemaNode
    const exec = { recordOffset: 0, sliceOffset: 0 }
    const code = { artifactId: ref('code-output-manifest-v1').id, revision: 'b'.repeat(64), cellId: 'cell', sourceId: 'source', offset: 0 }
    for (const query of [{ ref: ref('exec-frames-v1'), cursor: exec }, { ref: ref('code-output-manifest-v1'), cursor: code }]) {
      expect(validateJsonSchemaValue(schema, query)).toEqual([])
      expect(parseResultPageQuery(query)).toEqual(query)
    }
    for (const codec of ['exec-frames-v1', 'code-output-manifest-v1'] as const) {
      expect(parseResultPageQuery({ ref: ref(codec), cursor: { ...exec, ...code } })).toBeUndefined()
      expect(parseResultPageQuery({ ref: ref(codec), cursor: {} })).toBeUndefined()
    }
    expect(validateJsonSchemaValue(schema, { ref: ref('exec-frames-v1'), cursor: { ...exec, recordOffset: '0' } })).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { ref: ref('exec-frames-v1'), cursor: { ...exec, unknown: true } })).not.toEqual([])
  } finally { await service.close() }
})
