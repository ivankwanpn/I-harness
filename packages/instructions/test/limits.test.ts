import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { fixture, type Fixture } from './helpers/instruction-fixture.ts'
let f: Fixture
beforeEach(async () => { f = await fixture() })
afterEach(async () => { vi.restoreAllMocks(); await f.cleanup() })
it.each([0, 1, 11, 80, 180, 24000])('keeps UTF8, headers and markers inside a %i byte budget', async maxBytes => {
  await f.write('AGENTS.md', '漢😀'.repeat(10000))
  const s = await f.service({ maxBytes }).prepare([])
  expect(s.bytes).toBe(Buffer.byteLength(s.text)); expect(s.bytes).toBeLessThanOrEqual(maxBytes); expect(s.text).not.toContain('\uFFFD')
  if (maxBytes) { expect(s.complete).toBe(false); expect(s.sources[0].state).toBe('truncated'); expect(s.candidates[0].hashScope).not.toBe('full') }
  else { expect(s.complete).toBe(true); expect(s.reliability).toBe('ready') }
})
it('bounds actual read requests and bytes for a multi-MiB file', async () => {
  const file = await f.write('AGENTS.md', Buffer.alloc(4 * 1024 * 1024, 120))
  const open = fs.open.bind(fs); let requested = 0; let actual = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]) === file) { const read = handle.read.bind(handle); vi.spyOn(handle, 'read').mockImplementation(async (...input: any[]) => { requested += input[2]; const result = await (read as any)(...input); actual += result.bytesRead; return result }) }
    return handle
  })
  const s = await f.service().prepare([])
  expect(actual).toBeGreaterThan(0); expect(requested).toBeLessThanOrEqual(24004); expect(actual).toBeLessThanOrEqual(24004)
  expect(s.candidates[0].hashScope).toBe('prefix'); expect(s.candidates[0].observedSize).toBe(4194304); expect(s.text.endsWith('\n(truncated)')).toBe(true)
})
it.each([{ enabled: false }, { maxBytes: 0 }])('does zero filesystem/observation work when disabled or zero: %j', async options => {
  const open = vi.spyOn(fs, 'open'); const stat = vi.spyOn(fs, 'stat'); const realpath = vi.spyOn(fs, 'realpath')
  const service = f.service(options); const s = await service.prepare([]); service.snapshot()
  expect(s.text).toBe(''); expect(s.complete).toBe(true); expect(s.reliability).toBe('ready'); expect(open).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(realpath).not.toHaveBeenCalled(); expect(f.observation.subscriptions).toBe(0)
})
it('accounts for exact full header and content bytes', async () => {
  const file = await f.write('AGENTS.md', '漢😀')
  const s = await f.service().prepare([])
  expect(s.text).toBe(`### ${file} [scope: ${f.root}]\n\n漢😀`)
  expect(s.sources[0].bytes).toBe(Buffer.byteLength(s.text)); expect(s.candidates[0].hashScope).toBe('full')
})
it('caps ancestor depth and candidate slots without claiming completeness', async () => {
  const deep = f.path(...Array.from({ length: 128 }, () => 'd'))
  const depth = await f.service({ cwd: deep }).prepare([])
  expect(depth.complete).toBe(false); expect(depth.reliability).toBe('unavailable'); expect(depth.candidates.length).toBeLessThanOrEqual(256)
  const targets = Array.from({ length: 129 }, (_, i) => ({ path: f.path(`d${i}`), kind: 'directory' as const }))
  const capped = await f.service().prepare(targets)
  expect(capped.candidates.length).toBeLessThanOrEqual(256); expect(capped.complete).toBe(false); expect(capped.sources.length).toBeLessThanOrEqual(256)
})
it('bounds watch interests before an overflowing explicit global allowlist reaches observation', async () => {
  const globalSources = Array.from({ length: 300 }, (_, i) => f.path(`g${i}/AGENTS.md`))
  const s = await f.service({ roots: [], globalSources }).prepare([])
  expect(f.observation.interests.reduce((count, i) => count + i.candidates.length, 0)).toBeLessThanOrEqual(256)
  expect(s.candidates.length).toBeLessThanOrEqual(256); expect(s.complete).toBe(false); expect(s.reliability).toBe('unavailable')
})
it('accepts exactly 128 ancestor directories and 256 policy slots', async () => {
  const dirs = Array.from({ length: 127 }, () => 'd'); const deep = await f.dir(dirs.join('/'))
  await f.write('AGENTS.md', 'root-body'); const s = await f.service({ cwd: deep }).prepare([])
  expect(s.candidates).toHaveLength(256); expect(s.complete).toBe(true); expect(s.text).toContain('root-body')
})
