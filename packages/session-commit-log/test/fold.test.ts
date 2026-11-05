import { describe, expect, it } from 'vitest'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, commitDigest, type CommitRecord } from '../src/format.ts'
import { foldCommits } from '../src/fold.ts'

function chain(parts: Array<{ entries?: unknown[]; ops?: unknown[] }>) {
  const out: CommitRecord[] = []
  for (const [index, part] of parts.entries()) {
    const payload = { v: COMMIT_FORMAT_VERSION, seq: index + 1, prev: out.at(-1)?.digest ?? GENESIS_PREV, at: 'x', entries: part.entries ?? [], ops: part.ops ?? [] }
    out.push({ ...payload, digest: commitDigest(payload as never) } as CommitRecord)
  }
  return out
}

describe('foldCommits', () => {
  it('joins entries, merges meta and applies doc/intent/rewind', () => {
    const records = chain([
      { ops: [{ kind: 'header', value: { sessionId: 's', createdAt: 'c', formatVersion: 14 } }] },
      { entries: [{ type: 'a', seq: 0 }, { type: 'b', seq: 1 }], ops: [{ kind: 'meta', patch: { title: 't' } }] },
      { entries: [{ type: 'c', seq: 2 }], ops: [{ kind: 'doc', key: 'task', side: { digest: 'd'.repeat(64), bytes: 3 } }, { kind: 'intent', id: 'i1', intent: { kind: 'child-birth' } }] },
      { ops: [{ kind: 'intent-done', id: 'i1', outcome: 'committed' }, { kind: 'rewind', toSeq: 2 }, { kind: 'meta', patch: { title: 't2' } }] },
    ])
    const view = foldCommits(records)
    expect(view.header.sessionId).toBe('s')
    expect(view.entries.map(e => (e as { type?: string }).type)).toEqual(['a', 'b'])
    expect(view.meta.title).toBe('t2')
    expect(view.documents.get('task')).toEqual({ digest: 'd'.repeat(64), bytes: 3 })
    expect(view.intents.size).toBe(0)
    expect(view.deleted).toBe(false)
  })

  it('clears a document and keeps the remaining intents', () => {
    const view = foldCommits(chain([
      { ops: [{ kind: 'header', value: { sessionId: 's' } }] },
      { ops: [{ kind: 'doc', key: 'task', side: { digest: 'd'.repeat(64), bytes: 1 } }, { kind: 'intent', id: 'i1', intent: {} }] },
      { ops: [{ kind: 'doc-clear', key: 'task' }] },
    ]))
    expect(view.documents.size).toBe(0)
    expect(view.intents.size).toBe(1)
  })

  it('marks a deleted session', () => {
    const view = foldCommits(chain([{ ops: [{ kind: 'header', value: { sessionId: 's' } }] }, { ops: [{ kind: 'delete' }] }]))
    expect(view.deleted).toBe(true)
  })

  it('rejects a rewind beyond the committed entry count', () => {
    expect(() => foldCommits(chain([{ ops: [{ kind: 'header', value: { sessionId: 's' } }] }, { ops: [{ kind: 'rewind', toSeq: 5 }] }]))).toThrowError(/rewind/i)
  })

  it('rejects a log without a header', () => {
    expect(() => foldCommits([])).toThrowError(/header/i)
  })
})
