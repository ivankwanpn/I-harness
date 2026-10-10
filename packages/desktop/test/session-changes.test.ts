import { describe, expect, it } from 'vitest'
import { createTextDiff } from '../../text-diff/src/index.ts'
import type { TimelineRow } from '../src/renderer/session/project.ts'
import { buildSessionChanges } from '../src/renderer/review/session-changes.ts'
import { projectTimeline } from '../src/renderer/session/project.ts'

function edit(id: string, turnId: string, before: string, after: string, partial = false): TimelineRow {
  return { id, kind: 'tool', name: 'edit', resultReceived: true, ...(partial ? { isError: true as const } : {}), turn: { id: turnId, complete: true }, output: { change: createTextDiff('a.txt', before, after) } }
}
describe('recorded conversation changes', () => {
  it('marks a native partial apply_patch result without an event isError flag', () => {
    const diff = createTextDiff('a.txt', 'old\n', 'new\n')
    const rows = projectTimeline([
      { type: 'turn/start', seq: 0 },
      { type: 'tool/call', seq: 1, callId: 'patch', name: 'apply_patch', args: { patch_content: 'recorded patch' } },
      { type: 'tool/result', seq: 2, callId: 'patch', name: 'apply_patch', output: { ok: false, applied: [{ path: 'a.txt', action: 'updated', change: diff }], errors: [{ path: 'b.txt', message: 'context not found' }], change: diff } },
      { type: 'turn/end', seq: 3 },
    ])
    expect(buildSessionChanges(rows).entries).toHaveLength(1)
    expect(buildSessionChanges(rows).entries[0]?.failed).toBe(true)
  })
  it('uses recorded file edits independently of repository status', () => {
    const model = buildSessionChanges([edit('call-a', 'turn-a', 'old\n', 'new\n')])
    expect(model.entries).toHaveLength(1)
    expect(model.entries[0]!.diff.path).toBe('a.txt')
    expect(model.entries[0]!.diff.hunks[0]!.lines.some(line => line.kind === 'add' && line.text === 'new')).toBe(true)
    expect(model.latestTurnId).toBe('turn-a')
  })
  it('keeps repeated edits as separate recorded operations instead of inventing a net patch', () => {
    const model = buildSessionChanges([edit('first', 't', 'old\n', 'middle\n'), edit('second', 't', 'middle\n', 'final\n')])
    expect(model.entries).toHaveLength(2)
    expect(new Set(model.entries.map(entry => entry.id)).size).toBe(2)
    expect(model.entries[0]!.diff.hunks[0]!.lines.some(line => line.text === 'old')).toBe(true)
    expect(model.entries[1]!.diff.hunks[0]!.lines.some(line => line.text === 'middle')).toBe(true)
  })
  it('keeps the actual latest turn even when that turn recorded no file edits', () => {
    const model = buildSessionChanges([edit('old', 'turn-old', 'a', 'b'), { id: 'question', kind: 'message', role: 'user', text: 'explain this', turn: { id: 'turn-new', complete: true } }])
    expect(model.latestTurnId).toBe('turn-new')
    expect(model.entries.filter(entry => entry.turnId === model.latestTurnId)).toEqual([])
  })
  it('retains partial applied edits from a failed file operation', () => {
    const model = buildSessionChanges([edit('partial', 'turn', 'a', 'b', true)])
    expect(model.entries[0]!.failed).toBe(true)
  })
  it('ignores pending writes, unrelated tools and malformed change data', () => {
    const pending = { ...edit('pending', 't', 'a', 'b'), resultReceived: undefined } as TimelineRow
    const unrelated = { ...edit('other', 't', 'a', 'b'), name: 'websearch' } as TimelineRow
    const invalid = { id: 'bad', kind: 'tool' as const, name: 'edit', resultReceived: true as const, output: { change: { path: 'a.txt', added: 1, deleted: 0, truncated: false, hunks: [{ oldStart: -1, lines: [] }] } } }
    expect(buildSessionChanges([pending, unrelated, invalid]).entries).toEqual([])
  })
})
