import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { fixture, type Fixture } from './helpers/instruction-fixture.ts'
let f: Fixture
beforeEach(async () => { f = await fixture() })
afterEach(async () => { vi.restoreAllMocks(); await f.cleanup() })
it('re-reads same-size same-mtime writes only after invalidation, with zero clean stat/read work', async () => {
  const file = await f.write('AGENTS.md', 'before-body'); const service = f.service(); const first = await service.prepare([]); const meta = await fs.stat(file)
  const stat = vi.spyOn(fs, 'stat'), open = vi.spyOn(fs, 'open'); await service.prepare([])
  expect(stat).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  await fs.writeFile(file, 'after--body'); await fs.utimes(file, meta.atime, meta.mtime)
  f.observation.emit([file]); expect(service.snapshot().reliability).toBe('unavailable')
  const next = await service.prepare([]); expect(next.text).toContain('after--body'); expect(next.fingerprint).not.toBe(first.fingerprint)
})
it('tracks absence, priority and fallback even when selected bodies match', async () => {
  await f.write('CLAUDE.md', 'same-body'); const service = f.service(); const first = await service.prepare([])
  const preferred = await f.write('AGENTS.md', 'same-body'); f.observation.emit([preferred]); const next = await service.prepare([])
  expect(next.applicable[0].fingerprint).not.toBe(first.applicable[0].fingerprint); expect(next.candidates[0].selected).toBe(true)
  await fs.unlink(preferred); f.observation.emit([preferred]); const last = await service.prepare([])
  expect(last.candidates[1].selected).toBe(true); expect(last.text).toContain('same-body')
})
it('leaves an independent target fingerprint ready and stable across unrelated events and activation', async () => {
  const a = await f.write('a/AGENTS.md', 'alpha'); const b = await f.write('b/AGENTS.md', 'bravo')
  const service = f.service({ roots: [f.path('a'), f.path('b')] }); const first = await service.prepare([{ path: f.path('a'), kind: 'directory' }])
  f.observation.emit([b]); expect(service.snapshot()).toBe(first)
  const both = await service.prepare([{ path: f.path('b'), kind: 'directory' }]); expect(both.applicable[0].fingerprint).toBe(first.applicable[0].fingerprint)
  f.observation.emit([], 'pending', [{ id: 'other', paths: [b] }]); expect(service.snapshot().applicable[0].reliability).toBe('ready'); expect(service.snapshot().applicable[1].reliability).toBe('pending')
  expect(service.snapshot().candidates.find(c => c.path === a)?.pendingIds).toEqual([])
})
it.each(['initial', 'new-target'])('reconciles creation during %s watch installation', async mode => {
  await f.dir('a'); await f.dir('b'); const service = f.service({ cwd: f.path('a') })
  if (mode === 'new-target') await service.prepare([])
  f.observation.duringUpdate = async () => { await f.write(`${mode === 'initial' ? 'a' : 'b'}/AGENTS.md`, 'installed-body'); f.observation.duringUpdate = undefined }
  const s = await service.prepare(mode === 'initial' ? [] : [{ path: f.path('b'), kind: 'directory' }])
  expect(s.text).toContain('installed-body'); expect(s.reliability).toBe('ready')
})
it.each(['success', 'failed', 'partial'])('publishes pending immediately and reconciles %s write settlement', async outcome => {
  const file = await f.write('AGENTS.md', 'old-body'); const service = f.service(); const initial = await service.prepare([])
  f.observation.emit([], 'pending', [{ id: 'write-1', paths: [file] }]); expect(service.snapshot().reliability).toBe('pending'); expect(service.snapshot().complete).toBe(false)
  const second = await service.prepare([]); expect(second.reliability).toBe('pending'); expect(second.fingerprint).toBe(initial.fingerprint)
  if (outcome !== 'failed') await fs.writeFile(file, outcome === 'partial' ? 'part' : 'new-body')
  f.observation.emit([], 'pending', []); expect(service.snapshot().reliability).toBe('unavailable')
  const settled = await service.prepare([]); expect(settled.reliability).toBe('ready'); expect(settled.text).toContain(outcome === 'failed' ? 'old-body' : outcome === 'partial' ? 'part' : 'new-body')
})
it('rejects stale and contradictory observation revisions, then recovers through reset', async () => {
  const file = await f.write('AGENTS.md', 'body'); const service = f.service(); await service.prepare([])
  f.observation.emit([file]); await service.prepare([])
  f.observation.listener?.({ revision: 0, available: true, pending: [], paths: [], kind: 'changed' }); expect(service.snapshot().reliability).toBe('unavailable')
  f.observation.emit([], 'reset'); const s = await service.prepare([]); expect(s.reliability).toBe('ready')
  f.observation.listener?.({ ...f.observation.state, available: false, paths: [], kind: 'availability' }); expect(service.snapshot().reliability).toBe('unavailable')
})
it('treats pending Git boundary metadata as a pending applicable dependency', async () => {
  await f.write('AGENTS.md', 'broad'); await f.write('repo/AGENTS.md', 'narrow'); const marker = f.path('repo/.git')
  const service = f.service({ cwd: f.path('repo') }); await service.prepare([])
  f.observation.emit([], 'pending', [{ id: 'boundary-write', paths: [marker] }])
  expect(service.snapshot().applicable[0].reliability).toBe('pending')
  expect((await service.prepare([])).applicable[0].reliability).toBe('pending')
  await f.dir('repo/.git'); f.observation.emit([], 'pending', [])
  const done = await service.prepare([]); expect(done.text).not.toContain('broad'); expect(done.reliability).toBe('ready')
})
it('leaves the last reliable semantic fingerprint unchanged on duplicate observations and unrelated pending tokens', async () => {
  const file = await f.write('AGENTS.md', 'body'); const service = f.service(); await service.prepare([])
  f.observation.emit([file]); await service.prepare([]); const before = service.snapshot()
  f.observation.listener?.({ ...f.observation.state, kind: 'changed', paths: [file] }); expect(service.snapshot()).toBe(before)
  f.observation.emit([], 'pending', [{ id: 'irrelevant', paths: [f.path('other/AGENTS.md')] }]); expect(service.snapshot()).toBe(before)
})
it.each(['changed', 'pending'] as const)('reconciles canonical Git marker %s events through a real junction without disturbing another root', async kind => {
  await f.write('workspace/AGENTS.md', 'broad-rules'); await f.write('workspace/real/AGENTS.md', 'narrow-rules'); await f.write('independent/AGENTS.md', 'independent-rules')
  await fs.symlink(f.path('workspace/real'), f.path('workspace/alias'), 'junction')
  const target = { path: f.path('workspace/alias'), kind: 'directory' as const }
  const service = f.service({ roots: [f.path('workspace'), f.path('independent')] })
  const initial = await service.prepare([target, { path: f.path('independent'), kind: 'directory' }])
  expect(initial.text).toContain('broad-rules'); const independent = initial.applicable[1]
  const marker = f.path('workspace/real/.git')
  f.observation.emit([f.path('workspace/real-other/.git')]); expect(service.snapshot()).toBe(initial)
  if (kind === 'pending') {
    f.observation.emit([], 'pending', [{ id: 'canonical-marker', paths: [marker] }])
    expect(service.snapshot().applicable[0].reliability).toBe('pending')
    expect((await service.prepare([target])).applicable[0].reliability).toBe('pending')
  }
  await f.dir('workspace/real/.git')
  f.observation.emit(kind === 'changed' ? [marker] : [], kind, [])
  expect(service.snapshot().applicable[0].reliability).toBe('unavailable')
  expect(service.snapshot().applicable[1]).toEqual(independent)
  const narrowed = await service.prepare([target]); expect(narrowed.text).not.toContain('broad-rules'); expect(narrowed.text).toContain('narrow-rules'); expect(narrowed.applicable[0].reliability).toBe('ready'); expect(narrowed.applicable[1]).toEqual(independent)
  await fs.rmdir(marker); f.observation.emit([marker])
  expect(service.snapshot().applicable[0].reliability).toBe('unavailable'); expect(service.snapshot().applicable[1]).toEqual(independent)
  const widened = await service.prepare([target]); expect(widened.text).toContain('broad-rules'); expect(widened.applicable[0].reliability).toBe('ready'); expect(widened.applicable[1]).toEqual(independent)
})
