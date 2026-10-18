import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '../src/index.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'

it('restricted child registries inherit the actual parent retention port without inheriting its tool catalog', async () => {
  const ctx = createContext(), childCtx = ctx.scope.mount()
  let captures = 0, bodies = 0
  const port = { capture(_prepared: unknown, output: unknown, execution: any) { captures++; return createResultCapture(output, execution, { async openArtifact() { throw Object.assign(new Error('unsupported'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' }) } }) }, captureSynthetic() { throw new Error('unused') } }
  const parent = createToolRegistry(ctx, { resultRetention: port })
  parent.register({ name: 'hidden', description: '', inputSchema: {}, async execute() { return 'parent only' } })
  const child = createToolRegistry(childCtx, { inheritResultRetention: parent } as any)
  child.register({ name: 'large', description: '', inputSchema: {}, async execute() { bodies++; return 'x'.repeat(1_048_576) } })
  const result = await child.execute({ name: 'large', args: {} })
  expect(result.envelope?.retention.kind).toBe('unavailable')
  expect(Buffer.byteLength(JSON.stringify(result.envelope))).toBeLessThan(64000)
  expect(child.get('hidden')).toBeUndefined()
  expect(captures).toBe(1); expect(bodies).toBe(1)
  await childCtx.scope.unmount()
})
