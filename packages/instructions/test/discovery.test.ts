import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { fixture, type Fixture } from './helpers/instruction-fixture.ts'
import { createInstructionService } from '../src/service.ts'
let f: Fixture
beforeEach(async () => { f = await fixture() })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.cleanup() })

it.each(['agents', 'claude', 'both', 'empty', 'directory'])('enforces precedence for %s and records absent/shadowed slots', async mode => {
  if (mode !== 'claude') { if (mode === 'directory') await f.dir('AGENTS.md'); else await f.write('AGENTS.md', mode === 'empty' ? '' : 'preferred-body') }
  if (mode !== 'agents') await f.write('CLAUDE.md', 'fallback-body')
  const s = await f.service().prepare([])
  expect(s.candidates).toHaveLength(2)
  expect(s.candidates.filter(c => c.selected).map(c => c.kind)).toEqual([mode === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'])
  expect(s.text.includes('fallback-body')).toBe(mode === 'claude')
  if (mode === 'directory') { expect(s.reliability).toBe('unavailable'); expect(s.sources[0].state).toBe('unreadable') }
})
it('renders only broad-to-narrow rules under the narrowest authorized root', async () => {
  await f.write('AGENTS.md', 'excluded-parent'); await f.write('a/AGENTS.md', 'broad-body'); await f.write('a/b/CLAUDE.md', 'narrow-body'); await f.write('sibling/AGENTS.md', 'sibling-body')
  const s = await f.service({ roots: [f.root, f.path('a')], cwd: f.path('a/b') }).prepare([])
  expect(s.text).not.toContain('excluded-parent'); expect(s.text).not.toContain('sibling-body')
  expect(s.text.indexOf('broad-body')).toBeLessThan(s.text.indexOf('narrow-body'))
  expect(s.applicable[0].complete).toBe(true)
})
it.each(['directory', 'file', 'malformed'])('uses genuine Git %s boundary without widening malformed markers', async mode => {
  await f.write('AGENTS.md', 'outside-git'); await f.write('repo/AGENTS.md', 'inside-git'); await f.dir('repo/sub')
  if (mode === 'directory') await f.dir('repo/.git')
  else { const gitdir = await f.dir('metadata'); await f.write('repo/.git', mode === 'file' ? `gitdir: ${gitdir}\n` : 'not a git pointer') }
  const s = await f.service({ cwd: f.path('repo/sub') }).prepare([])
  expect(s.text).not.toContain('outside-git')
  expect(s.complete).toBe(mode !== 'malformed')
  expect(s.reliability).toBe(mode === 'malformed' ? 'unavailable' : 'ready')
})
it('does not give cwd or explicit targets authority outside roots', async () => {
  await f.write('outside/AGENTS.md', 'secret-body'); await f.dir('allowed')
  const s = await f.service({ cwd: f.path('outside'), roots: [f.path('allowed')] }).prepare([])
  expect(s.text).toBe(''); expect(s.complete).toBe(false); expect(s.sources[0].state).toBe('outside-scope')
})
it('keeps exact global allowlists, configured pairing, order and dedupe', async () => {
  const a = await f.write('g/AGENTS.md', 'global-preferred'); const c = await f.write('g/CLAUDE.md', 'global-fallback'); const d = await f.write('h/CLAUDE.md', 'second-global')
  const exact = await f.service({ roots: [], globalSources: [c, d, c] }).prepare([])
  expect(exact.text).toContain('global-fallback'); expect(exact.text).not.toContain('global-preferred'); expect(exact.candidates).toHaveLength(2)
  expect(exact.text).toContain('[global scope:')
  const paired = await f.service({ roots: [], globalSources: [c, d, a] }).prepare([])
  expect(paired.text).toContain('global-preferred'); expect(paired.text).not.toContain('global-fallback'); expect(paired.text.indexOf('global-preferred')).toBeLessThan(paired.text.indexOf('second-global'))
  await fs.unlink(a)
  const missing = await f.service({ roots: [], globalSources: [a, c] }).prepare([])
  expect(missing.text).toContain('global-fallback'); expect(missing.candidates[0].presence).toBe('absent')
})
it('preserves alias scope identity and refuses a real Windows junction escape', async () => {
  await f.write('allowed/real/AGENTS.md', 'shared-body'); await f.write('outside/AGENTS.md', 'escaped-body')
  await fs.symlink(f.path('allowed/real'), f.path('allowed/alias'), 'junction')
  await fs.symlink(f.path('outside'), f.path('allowed/escape'), 'junction')
  const s = await f.service({ roots: [f.path('allowed')] }).prepare([{ path: f.path('allowed/real'), kind: 'directory' }, { path: f.path('allowed/alias'), kind: 'directory' }, { path: f.path('allowed/escape'), kind: 'directory' }])
  expect(s.applicable).toHaveLength(3); expect(s.text).not.toContain('escaped-body'); expect(s.applicable[2].complete).toBe(false)
  expect(s.applicable[0].fingerprint).not.toBe(s.applicable[1].fingerprint)
})
it('validates configuration and detaches/freezes scope data', async () => {
  expect(() => f.service({ maxBytes: -1 })).toThrowError(expect.objectContaining({ code: 'INSTRUCTIONS_INVALID_CONFIG' }))
  expect(() => f.service({ cwd: 'relative' })).toThrowError(expect.objectContaining({ code: 'INSTRUCTIONS_INVALID_CONFIG' }))
  const roots = [f.root]; const service = f.service({ roots }); roots.splice(0)
  await f.write('AGENTS.md', 'retained-root'); const s = await service.prepare([])
  expect(s.text).toContain('retained-root'); expect(Object.isFrozen(s)).toBe(true); expect(Object.isFrozen(s.candidates[0])).toBe(true)
})
it('never reads ambient synthetic home/.claude/.codex sentinels', async () => {
  await f.write('ambient/AGENTS.md', 'home-sentinel'); await f.write('ambient/.claude/CLAUDE.md', 'claude-sentinel'); await f.write('ambient/.codex/AGENTS.md', 'codex-sentinel'); const root = await f.dir('workspace')
  vi.stubEnv('HOME', f.path('ambient')); vi.stubEnv('USERPROFILE', f.path('ambient'))
  const open = vi.spyOn(fs, 'open'), stat = vi.spyOn(fs, 'stat'), real = vi.spyOn(fs, 'realpath')
  const s = await f.service({ roots: [root], cwd: root }).prepare([])
  expect(s.text).toBe(''); expect([...open.mock.calls, ...stat.mock.calls, ...real.mock.calls].every(call => !String(call[0]).includes('ambient'))).toBe(true)
})
it('deduplicates actual Windows casing/separator aliases without merging distinct scopes', async () => {
  await f.write('scope/AGENTS.md', 'body'); const service = f.service()
  const s = await service.prepare([{ path: f.path('scope'), kind: 'directory' }, { path: f.path('scope').toUpperCase().replaceAll('\\', '/'), kind: 'directory' }, { path: f.path('scope/missing.ts'), kind: 'file' }])
  expect(s.applicable).toHaveLength(2); expect(s.applicable.every(a => a.complete)).toBe(true)
})
it('fails closed when a worktree marker points to a missing Git directory', async () => {
  await f.write('AGENTS.md', 'must-not-widen'); await f.write('repo/.git', 'gitdir: ../missing-metadata\n')
  const s = await f.service({ cwd: f.path('repo') }).prepare([])
  expect(s.reliability).toBe('unavailable'); expect(s.complete).toBe(false); expect(s.text).not.toContain('must-not-widen')
})
it('does not invoke inherited data getters during configuration validation', () => {
  let accessed = 0; const scope = Object.create({ get cwd() { accessed++; return f.root } })
  Object.assign(scope, { roots: [f.root], globalSources: [], enabled: true, maxBytes: 24000 })
  expect(() => createInstructionService({ scope, observation: f.observation })).toThrowError(expect.objectContaining({ code: 'INSTRUCTIONS_INVALID_CONFIG' }))
  expect(accessed).toBe(0)
})
