import { expect, it } from 'vitest'
import { readForkRequestCore } from '../src/fork-contract.ts'
import { PROVIDER_PROTOCOLS } from '@i-harness/settings'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const core = () => ({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: { title: 'original' } })
it('captures closed browser core data and preserves the existing protocol population', () => {
  const input = core(), result = readForkRequestCore(input)
  input.metadata.title = 'later'
  expect(result.metadata.title).toBe('original')
  expect(Object.isFrozen(result.selection)).toBe(true)
  for (const protocol of PROVIDER_PROTOCOLS) expect(readForkRequestCore({ ...core(), metadata: { modelSelection: { provider: 'p', model: 'm', protocol } } }).metadata.modelSelection?.protocol).toBe(protocol)
})
it.each(['../source', 'a/b', 'a\\b', 'a\u007f', '', 'x'.repeat(257)])('rejects unsafe source %s', sourceSessionId => {
  expect(() => readForkRequestCore({ ...core(), sourceSessionId })).toThrow(TypeError)
})
it('rejects unknown, hidden, undefined and accessor data without invoking getters', () => {
  let reads = 0
  for (const input of [{ ...core(), extra: true }, { ...core(), selection: { kind: 'completed', atSeq: undefined } }, Object.defineProperty(core(), 'hidden', { value: 1 }), { ...core(), metadata: Object.defineProperty({}, 'title', { enumerable: true, get() { reads++; return 'bad' } }) }]) expect(() => readForkRequestCore(input)).toThrow(TypeError)
  expect(reads).toBe(0)
  expect(() => readForkRequestCore({ ...core(), metadata: { title: '😀'.repeat(8193) } })).toThrow(TypeError)
  expect(() => readForkRequestCore({ ...core(), selection: { kind: 'completed', atSeq: -1 } })).toThrow(TypeError)
})
it('P01 browser leaf bundles without a runtime Node, SDK, persistence or engine import',async()=>{
  const result=await build({entryPoints:[fileURLToPath(new URL('../src/fork-contract.ts',import.meta.url))],bundle:true,write:false,platform:'browser',format:'esm',metafile:true})
  expect(Object.keys(result.metafile!.inputs)).toHaveLength(1)
  expect(result.outputFiles![0]!.text).toContain('readForkRequestCore')
})
