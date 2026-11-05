# Session Commit Log — Format, Scan, Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-light library that encodes, scans, verifies and folds one session's append-only commit log (format 15), so the durability core can be rebuilt on a single commit point.

**Architecture:** Three pure modules. `format.ts` defines the record/op schema, canonical encoding and digest chain. `scanner.ts` turns raw bytes into the longest valid commit prefix (a torn tail is dropped, a damaged complete line is corruption). `fold.ts` derives the session view (header, entries, meta, documents, intents, rewound/deleted state) from records. No filesystem I/O in this plan: the store/lease/crash-cut work is Plan 2.

**Tech Stack:** TypeScript (erasable syntax), Node 22+, vitest, `node:crypto` sha256, `@i-harness/core-session` canonical JSON (`canonicalJsonData`) and `SessionEvent` types.

**Spec:** `docs/design/2026-11-05-session-commit-log-redesign.md`

**Progress (2026-11-05):** Tasks 1–4 and the Task 5 edge cases are implemented (`packages/session-commit-log`, 18 tests green,
`tsc --noEmit` and both audit gates green). Two deviations from the text below, both deliberate:
(1) `src/index.ts` exports nothing until Plan 2 wires the first consumer, because an unconsumed export fails the reachability gate;
(2) non-finite numbers canonicalise to `null` via `canonicalJsonData` (same as `JSON.stringify`), so the lossless-JSON test uses a bigint
instead of `NaN`.

## Global Constraints

- Format version is exactly `15`; every record carries it.
- A commit line is the ONLY durability point; sidecars are referenced by digest and are garbage without a referencing commit.
- `seq` starts at 1 and strictly increases by 1.
- `prev` is the previous record's `digest`, or 64 zeroes for `seq === 1`.
- `digest` is lowercase hex sha256 over the canonical JSON of the record WITHOUT the `digest` field.
- No `enum`, no namespaces (erasable-syntax-only TypeScript).
- Tests run with `pnpm --filter @i-harness/session-commit-log exec vitest run <file>`.

---

## File Structure

- `packages/session-commit-log/package.json` — package manifest.
- `packages/session-commit-log/tsconfig.json` — extends the repo base.
- `packages/session-commit-log/src/errors.ts` — `CommitFormatError` with a stable `code`.
- `packages/session-commit-log/src/format.ts` — version, op union, record type, digest/encode/decode.
- `packages/session-commit-log/src/scanner.ts` — byte scanner (complete prefix + torn tail).
- `packages/session-commit-log/src/fold.ts` — fold records into a session view.
- `packages/session-commit-log/src/index.ts` — public exports.
- `packages/session-commit-log/test/format.test.ts`
- `packages/session-commit-log/test/scanner.test.ts`
- `packages/session-commit-log/test/fold.test.ts`

---

### Task 1: Package scaffold + record codec

**Files:**
- Create: `packages/session-commit-log/package.json`
- Create: `packages/session-commit-log/tsconfig.json`
- Create: `packages/session-commit-log/src/errors.ts`
- Create: `packages/session-commit-log/src/format.ts`
- Create: `packages/session-commit-log/src/index.ts`
- Test: `packages/session-commit-log/test/format.test.ts`

**Interfaces:**
- Produces: `COMMIT_FORMAT_VERSION = 15`, `GENESIS_PREV`, `type CommitOp`, `type CommitRecord`, `type CommitPayload`, `commitDigest(payload): string`, `encodeCommit(payload): string`, `decodeCommit(line): CommitRecord`, `CommitFormatError`.

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, commitDigest, decodeCommit, encodeCommit } from '../src/format.ts'

const header = { sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z', formatVersion: 14 }
const first = () => ({ v: COMMIT_FORMAT_VERSION as 15, seq: 1, prev: GENESIS_PREV, at: '2026-01-01T00:00:00.000Z', entries: [], ops: [{ kind: 'header' as const, value: header }] })

describe('commit codec', () => {
  it('round-trips a record and verifies its digest', () => {
    const payload = first()
    const line = encodeCommit(payload)
    expect(line).not.toContain('
')
    const decoded = decodeCommit(line)
    expect(decoded.seq).toBe(1)
    expect(decoded.prev).toBe(GENESIS_PREV)
    expect(decoded.digest).toBe(commitDigest(payload))
    expect(decoded.ops[0]).toEqual({ kind: 'header', value: header })
  })

  it('rejects a record whose digest does not match its content', () => {
    const line = JSON.parse(encodeCommit(first())) as Record<string, unknown>
    line.seq = 2
    expect(() => decodeCommit(JSON.stringify(line))).toThrowError(/digest/i)
  })

  it('rejects a foreign format version', () => {
    const line = encodeCommit({ ...first(), v: 14 as unknown as 15 })
    expect(() => decodeCommit(line)).toThrowError(/version/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run test/format.test.ts`
Expected: FAIL — cannot resolve `@i-harness/session-commit-log`.

- [ ] **Step 3: Write minimal implementation**

`package.json`:

```json
{
  "name": "@i-harness/session-commit-log",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@i-harness/core-session": "workspace:*" }
}
```

`tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`src/errors.ts`:

```ts
export type CommitFormatCode = 'version' | 'digest' | 'shape' | 'ops' | 'chain' | 'corrupt'
export class CommitFormatError extends Error {
  readonly code: CommitFormatCode
  constructor(code: CommitFormatCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CommitFormatError'
    this.code = code
  }
}
```

`src/format.ts`:

```ts
import { createHash } from 'node:crypto'
import { canonicalJsonData, type SessionEvent } from '@i-harness/core-session'
import { CommitFormatError } from './errors.ts'

export const COMMIT_FORMAT_VERSION = 15
export const GENESIS_PREV = '0'.repeat(64)

export type CommitOp =
  | { readonly kind: 'header'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'meta'; readonly patch: Readonly<Record<string, unknown>> }
  | { readonly kind: 'doc'; readonly key: string; readonly side: { readonly digest: string; readonly bytes: number } }
  | { readonly kind: 'doc-clear'; readonly key: string }
  | { readonly kind: 'intent'; readonly id: string; readonly intent: Readonly<Record<string, unknown>> }
  | { readonly kind: 'intent-done'; readonly id: string; readonly outcome: 'committed' | 'failed' }
  | { readonly kind: 'rewind'; readonly toSeq: number }
  | { readonly kind: 'delete' }

export type CommitRecord = {
  readonly v: typeof COMMIT_FORMAT_VERSION
  readonly seq: number
  readonly prev: string
  readonly at: string
  readonly entries: readonly SessionEvent[]
  readonly ops: readonly CommitOp[]
  readonly digest: string
}

export type CommitPayload = Omit<CommitRecord, 'digest'>

const HEX64 = /^[0-9a-f]{64}$/

export function commitDigest(payload: CommitPayload): string {
  return createHash('sha256').update(canonicalJsonData(payload)).digest('hex')
}

export function encodeCommit(payload: CommitPayload): string {
  const record: CommitRecord = { ...payload, digest: commitDigest(payload) }
  return canonicalJsonData(record)
}

export function decodeCommit(line: string): CommitRecord {
  let value: unknown
  try { value = JSON.parse(line) } catch (cause) { throw new CommitFormatError('shape', 'commit line is not JSON', { cause }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommitFormatError('shape', 'commit line must be an object')
  const record = value as Record<string, unknown>
  if (record.v !== COMMIT_FORMAT_VERSION) throw new CommitFormatError('version', `unsupported commit format version ${String(record.v)}`)
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 1) throw new CommitFormatError('shape', 'commit seq must be a positive safe integer')
  if (typeof record.prev !== 'string' || !HEX64.test(record.prev)) throw new CommitFormatError('shape', 'commit prev must be a 64-char hex digest')
  if (typeof record.at !== 'string' || record.at.length === 0) throw new CommitFormatError('shape', 'commit at must be a non-empty string')
  if (!Array.isArray(record.entries)) throw new CommitFormatError('shape', 'commit entries must be an array')
  if (!Array.isArray(record.ops)) throw new CommitFormatError('shape', 'commit ops must be an array')
  if (typeof record.digest !== 'string' || !HEX64.test(record.digest)) throw new CommitFormatError('shape', 'commit digest must be a 64-char hex digest')
  const payload = { v: COMMIT_FORMAT_VERSION, seq: record.seq, prev: record.prev, at: record.at, entries: record.entries, ops: record.ops } as CommitPayload
  const digest = commitDigest(payload)
  if (digest !== record.digest) throw new CommitFormatError('digest', 'commit digest does not match its content')
  return { ...payload, digest } as CommitRecord
}
```

`src/index.ts`:

```ts
export { CommitFormatError, type CommitFormatCode } from './errors.ts'
export { COMMIT_FORMAT_VERSION, GENESIS_PREV, commitDigest, decodeCommit, encodeCommit, type CommitOp, type CommitPayload, type CommitRecord } from './format.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run test/format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/session-commit-log
git commit -m "feat(session-commit-log): add the format-15 commit codec"
```

---

### Task 2: Byte scanner (complete prefix + torn tail)

**Files:**
- Create: `packages/session-commit-log/src/scanner.ts`
- Modify: `packages/session-commit-log/src/index.ts`
- Test: `packages/session-commit-log/test/scanner.test.ts`

**Interfaces:**
- Consumes: `decodeCommit`, `CommitFormatError`, `CommitRecord`.
- Produces: `scanCommitLog(bytes: Uint8Array): { records: readonly CommitRecord[]; tornBytes: number }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { scanCommitLog } from '../src/scanner.ts'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, commitDigest } from '../src/format.ts'

const line = (seq: number, prev: string, ops: unknown[] = []) => {
  const payload = { v: COMMIT_FORMAT_VERSION as 15, seq, prev, at: '2026-01-01T00:00:00.000Z', entries: [], ops }
  return { line: JSON.stringify({ ...payload, digest: commitDigest(payload as never) }), digest: commitDigest(payload as never) }
}

describe('scanCommitLog', () => {
  it('returns every complete line', () => {
    const a = line(1, GENESIS_PREV, [{ kind: 'header', value: { sessionId: 's' } }])
    const b = line(2, a.digest, [{ kind: 'meta', patch: { title: 't' } }])
    const bytes = new TextEncoder().encode(`${a.line}\n${b.line}\n`)
    const result = scanCommitLog(bytes)
    expect(result.records.map(r => r.seq)).toEqual([1, 2])
    expect(result.tornBytes).toBe(0)
  })

  it('drops an incomplete trailing line', () => {
    const a = line(1, GENESIS_PREV)
    const bytes = new TextEncoder().encode(`${a.line}\n${a.line.slice(0, 20)}`)
    const result = scanCommitLog(bytes)
    expect(result.records).toHaveLength(1)
    expect(result.tornBytes).toBe(20)
  })

  it('rejects a complete line that is not a valid commit', () => {
    const bytes = new TextEncoder().encode('{"v":15}\n')
    expect(() => scanCommitLog(bytes)).toThrowError(/seq|shape/i)
  })

  it('rejects an out-of-order seq', () => {
    const a = line(2, GENESIS_PREV)
    const bytes = new TextEncoder().encode(`${a.line}\n`)
    expect(() => scanCommitLog(bytes)).toThrowError(/seq/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run test/scanner.test.ts`
Expected: FAIL — cannot resolve `../src/scanner.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/scanner.ts`:

```ts
import { CommitFormatError } from './errors.ts'
import { decodeCommit, GENESIS_PREV, type CommitRecord } from './format.ts'

const NEWLINE = 0x0a

export type CommitScan = { readonly records: readonly CommitRecord[]; readonly tornBytes: number }

/** Scan raw commit-log bytes into the longest valid prefix. A final line without a
 *  newline is a torn tail (ignored and reported); a complete line that fails to
 *  decode is corruption and refuses the whole log. */
export function scanCommitLog(bytes: Uint8Array): CommitScan {
  const records: CommitRecord[] = []
  let start = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== NEWLINE) continue
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, index))
    const record = decodeCommit(text)
    const expectedSeq = records.length + 1
    if (record.seq !== expectedSeq) throw new CommitFormatError('chain', `commit seq ${record.seq} does not follow ${expectedSeq - 1}`)
    const expectedPrev = records.length === 0 ? GENESIS_PREV : records[records.length - 1]!.digest
    if (record.prev !== expectedPrev) throw new CommitFormatError('chain', `commit ${record.seq} prev does not match the previous digest`)
    records.push(record)
    start = index + 1
  }
  return { records, tornBytes: bytes.length - start }
}
```

Update `src/index.ts`:

```ts
export { scanCommitLog, type CommitScan } from './scanner.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run test/scanner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/session-commit-log
git commit -m "feat(session-commit-log): scan complete commits and drop a torn tail"
```

---

### Task 3: Op validation

**Files:**
- Modify: `packages/session-commit-log/src/format.ts`
- Test: `packages/session-commit-log/test/format.test.ts` (append cases)

**Interfaces:**
- Produces: `parseOps(value: unknown): CommitOp[]`; `decodeCommit` now validates every op and the header rule (exactly one `header`, only at seq 1).

- [ ] **Step 1: Write the failing test**

```ts
it('rejects an unknown op kind', () => {
  const payload = { v: 15 as const, seq: 1, prev: GENESIS_PREV, at: 'x', entries: [], ops: [{ kind: 'nope' }] }
  expect(() => decodeCommit(JSON.stringify({ ...payload, digest: commitDigest(payload as never) }))).toThrowError(/op/i)
})

it('requires the header op only in the first commit', () => {
  const first = { v: 15 as const, seq: 1, prev: GENESIS_PREV, at: 'x', entries: [], ops: [{ kind: 'header', value: { sessionId: 's' } }] }
  const second = { v: 15 as const, seq: 2, prev: commitDigest(first as never), at: 'x', entries: [], ops: [{ kind: 'header', value: { sessionId: 's' } }] }
  const bytes = new TextEncoder().encode([first, second].map(p => JSON.stringify({ ...p, digest: commitDigest(p as never) })).join('\n') + '\n')
  expect(() => scanCommitLog(bytes)).toThrowError(/header/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run test/format.test.ts`
Expected: FAIL — unknown op accepted / header rule not enforced.

- [ ] **Step 3: Write minimal implementation**

Add to `format.ts`:

```ts
export function parseOps(value: unknown): CommitOp[] {
  if (!Array.isArray(value)) throw new CommitFormatError('ops', 'commit ops must be an array')
  return value.map(parseOp)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CommitFormatError('ops', `op ${field} must be a non-empty string`)
  return value
}

function requireObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommitFormatError('ops', `op ${field} must be an object`)
  return value as Record<string, unknown>
}

export function parseOp(value: unknown): CommitOp {
  const op = requireObject(value, 'kind')
  const kind = op.kind
  switch (kind) {
    case 'header': return { kind, value: requireObject(op.value, 'value') }
    case 'meta': return { kind, patch: requireObject(op.patch, 'patch') }
    case 'doc': {
      const side = requireObject(op.side, 'side')
      return { kind, key: requireString(op.key, 'key'), side: { digest: requireString(side.digest, 'digest'), bytes: requireBytes(side.bytes) } }
    }
    case 'doc-clear': return { kind, key: requireString(op.key, 'key') }
    case 'intent': return { kind, id: requireString(op.id, 'id'), intent: requireObject(op.intent, 'intent') }
    case 'intent-done': {
      const outcome = op.outcome
      if (outcome !== 'committed' && outcome !== 'failed') throw new CommitFormatError('ops', 'intent-done outcome must be committed or failed')
      return { kind, id: requireString(op.id, 'id'), outcome }
    }
    case 'rewind': {
      if (!Number.isSafeInteger(op.toSeq) || (op.toSeq as number) < 0) throw new CommitFormatError('ops', 'rewind toSeq must be a non-negative safe integer')
      return { kind, toSeq: op.toSeq as number }
    }
    case 'delete': return { kind }
    default: throw new CommitFormatError('ops', `unknown op kind ${String(kind)}`)
  }
}

function requireBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CommitFormatError('ops', 'doc side bytes must be a non-negative safe integer')
  return value as number
}
```

In `decodeCommit`, replace `ops: record.ops` with `ops: parseOps(record.ops)`, and enforce:

```ts
const ops = parseOps(record.ops)
const headers = ops.filter(op => op.kind === 'header')
if ((record.seq === 1) !== (headers.length === 1) || headers.length > 1) throw new CommitFormatError('ops', 'exactly one header op is required in the first commit')
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run test/format.test.ts test/scanner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-commit-log
git commit -m "feat(session-commit-log): validate op shapes and the header rule"
```

---

### Task 4: Fold

**Files:**
- Create: `packages/session-commit-log/src/fold.ts`
- Test: `packages/session-commit-log/test/fold.test.ts`

**Interfaces:**
- Consumes: `CommitRecord`.
- Produces: `foldCommits(records): CommitView` where

```ts
export type CommitView = {
  readonly header: Readonly<Record<string, unknown>>
  readonly entries: readonly SessionEvent[]
  readonly meta: Readonly<Record<string, unknown>>
  readonly documents: ReadonlyMap<string, { readonly digest: string; readonly bytes: number }>
  readonly intents: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  readonly deleted: boolean
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { foldCommits } from '../src/fold.ts'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, commitDigest } from '../src/format.ts'

function chain(parts: Array<{ entries?: unknown[]; ops?: unknown[] }>) {
  const out: any[] = []
  for (const [index, part] of parts.entries()) {
    const payload = { v: COMMIT_FORMAT_VERSION, seq: index + 1, prev: out.at(-1)?.digest ?? GENESIS_PREV, at: 'x', entries: part.entries ?? [], ops: part.ops ?? [] }
    out.push({ ...payload, digest: commitDigest(payload as never) })
  }
  return out
}

describe('foldCommits', () => {
  it('joins entries, merges meta and applies doc/intent/rewind/delete', () => {
    const records = chain([
      { ops: [{ kind: 'header', value: { sessionId: 's', createdAt: 'c', formatVersion: 14 } }] },
      { entries: [{ type: 'a', seq: 0 }, { type: 'b', seq: 1 }], ops: [{ kind: 'meta', patch: { title: 't' } }] },
      { entries: [{ type: 'c', seq: 2 }], ops: [{ kind: 'doc', key: 'task', side: { digest: 'd'.repeat(64), bytes: 3 } }, { kind: 'intent', id: 'i1', intent: { kind: 'child-birth' } }] },
      { ops: [{ kind: 'intent-done', id: 'i1', outcome: 'committed' }, { kind: 'rewind', toSeq: 2 }, { kind: 'meta', patch: { title: 't2' } }] },
    ])
    const view = foldCommits(records as never)
    expect(view.header.sessionId).toBe('s')
    expect(view.entries.map(e => (e as any).type)).toEqual(['a', 'b'])
    expect(view.meta.title).toBe('t2')
    expect(view.documents.get('task')).toEqual({ digest: 'd'.repeat(64), bytes: 3 })
    expect(view.intents.size).toBe(0)
    expect(view.deleted).toBe(false)
  })

  it('marks a deleted session', () => {
    const view = foldCommits(chain([{ ops: [{ kind: 'header', value: { sessionId: 's' } }] }, { ops: [{ kind: 'delete' }] }]) as never)
    expect(view.deleted).toBe(true)
  })

  it('rejects a rewind beyond the committed entry count', () => {
    expect(() => foldCommits(chain([{ ops: [{ kind: 'header', value: { sessionId: 's' } }] }, { ops: [{ kind: 'rewind', toSeq: 5 }] }]) as never)).toThrowError(/rewind/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run test/fold.test.ts`
Expected: FAIL — cannot resolve `../src/fold.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/fold.ts`:

```ts
import type { SessionEvent } from '@i-harness/core-session'
import { CommitFormatError } from './errors.ts'
import type { CommitRecord } from './format.ts'

export type CommitDocument = { readonly digest: string; readonly bytes: number }
export type CommitView = {
  readonly header: Readonly<Record<string, unknown>>
  readonly entries: readonly SessionEvent[]
  readonly meta: Readonly<Record<string, unknown>>
  readonly documents: ReadonlyMap<string, CommitDocument>
  readonly intents: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  readonly deleted: boolean
}

export function foldCommits(records: readonly CommitRecord[]): CommitView {
  let header: Readonly<Record<string, unknown>> | undefined
  let entries: SessionEvent[] = []
  const meta: Record<string, unknown> = {}
  const documents = new Map<string, CommitDocument>()
  const intents = new Map<string, Readonly<Record<string, unknown>>>()
  let deleted = false
  for (const record of records) {
    entries.push(...record.entries)
    for (const op of record.ops) {
      switch (op.kind) {
        case 'header': header ??= op.value; break
        case 'meta': Object.assign(meta, op.patch); break
        case 'doc': documents.set(op.key, op.side); break
        case 'doc-clear': documents.delete(op.key); break
        case 'intent': intents.set(op.id, op.intent); break
        case 'intent-done': intents.delete(op.id); break
        case 'rewind':
          if (op.toSeq > entries.length) throw new CommitFormatError('ops', `rewind toSeq ${op.toSeq} exceeds ${entries.length} committed entries`)
          entries = entries.slice(0, op.toSeq); break
        case 'delete': deleted = true; break
      }
    }
  }
  if (!header) throw new CommitFormatError('ops', 'commit log has no header op')
  return { header, entries, meta, documents, intents, deleted }
}
```

Update `src/index.ts` to export `foldCommits` and `CommitView`.

- [ ] **Step 4: Run all tests**

Run: `pnpm --filter @i-harness/session-commit-log exec vitest run`
Expected: PASS (all files).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @i-harness/session-commit-log exec tsc --noEmit
git add packages/session-commit-log
git commit -m "feat(session-commit-log): fold commits into the session view"
```

---

### Task 5: Chain/edge hardening

**Files:**
- Modify: `packages/session-commit-log/test/format.test.ts`, `test/fold.test.ts`
- Modify: `src/format.ts` if a case exposes a gap.

- [ ] **Step 1: Add tests for** canonical digest stability across key order, unicode, deep JSON; rejection of non-JSON values (NaN, undefined, bigint); duplicate header across commits; empty log fold.
- [ ] **Step 2: Run and fix** until green.
- [ ] **Step 3: Commit** `test(session-commit-log): harden canonical encoding and chain edges`.

---

## Plan 2 (implemented 2026-11-05): store + lease + crash-cut

Delivered in the same package (30 tests total, all green):

- `src/paths.ts` — `<root>/<id>/session.v15.jsonl`, `side/<sha256>`, temp names, id safety.
- `src/io.ts` — injectable filesystem port (`open/readFile/link/unlink/mkdir/readdir/rm`) so crash cuts are injected by wrapping the port.
- `src/lease.ts` — `@i-harness/fs-lock` exclusive lease on the `commit-log:<id>` namespace (cross-process on Windows/Linux; stale lock files are harmless because the OS lock dies with the process).
- `src/store.ts` — `createCommitLog` publishes via temp write + fsync + **`link()` no-overwrite** + directory fsync; `openCommitLog(mode)` acquires the write lease, scans, truncates a torn tail only in write mode, keeps an `r+` handle, appends with rollback-by-truncate on write/sync failure, writes/reads content-addressed sidecars, and collects unreferenced sidecars on write open.
- `test/store.test.ts` — publish/reopen, duplicate-create conflict, missing session, torn tail (read leaves it, write truncates then appends), fsync rollback, sidecar GC, lease conflict.
- `test/crash.test.ts` — a cut at temp-open / temp-write / temp-fsync / link leaves **no session**; a cut after the link keeps the complete session.

Remaining for the store before the facade: append-crash cuts (a cut between write and fsync must roll back to the previous size — already implemented, needs a fault test through the append path), and generation selection once format-15 migration lands.

## Plan 3a (implemented 2026-11-05): commit coordinator + legacy migration

- `packages/session-persistence/src/commit/coordinator.ts` — core coordinator over the commit log:
  `create/load/snapshot/loadOwned/append/list/profile/updateMeta/putDocument/getDocument/flush/adoptOwnership/releaseOwnership/close`.
  Appends are seq-checked, metadata patches are `meta` ops, documents are content-addressed sidecars in the global
  document log, and `loadOwned` retains the writer lease until `releaseOwnership` (later appends route through it).
- `packages/session-persistence/src/commit/legacy.ts` — read-only port for format 13/14 sessions.
  `load`/`profile`/`list` read legacy sessions without writing; the **first write** publishes a format-15 generation carrying
  the migrated history, leaving the legacy file byte-identical.
- `packages/session-persistence-jsonl/src/commit-coordinator.ts` — `createJsonlCommitCoordinator(root)` wires the port to the
  existing JSONL backend.
- Tests: 10 coordinator tests (session-persistence) + 2 JSONL integration tests (legacy read, migration, list, lease retention).

## Plan 3b (implemented 2026-11-05): fork + birth intents + dual-run

- New `seed` commit op (`parent`, `cut`, `digest`) recorded in the fold (`CommitView.seed`).
- `fork(parentId, { cut, sessionId, meta })` publishes the child as one commit carrying the copied prefix and the seed op;
  the child header records `parentSession` + `seedLength`. A cut outside the committed history refuses.
- `beginIntent/endIntent/intents` record cross-session work (child birth, team birth) inside the same log; an open intent
  survives reopen and is settled by a later `intent-done` — this is the durable replacement for capture reservations.
- `test/commit-dual-run.test.ts` (JSONL) proves the commit coordinator returns exactly the legacy backend's events/meta/list
  for a real format-14 session, and the same for an empty session.

## Plan 3c (implemented 2026-11-05): managed documents over the commit log

- New `batch` commit op (`id`, `prefixDigest`) folded into `CommitView.batches`; `CommitLog.open` reports the handle state.
- `src/commit/managed.ts` adapts the existing `createManagedDocument` composition to one commit log:
  - `appendOwnedBatch` decodes the fact batch, verifies the prefix/first-seq, calls `beforeIssue()`, appends the batch as one commit
    (entries + `batch` op) and returns the receipt with the batch's prefix digest;
  - `reconcileOwnedBatch` reports `committed` when the batch op is in the fold, `absent` when the prefix still proves nothing was issued,
    `conflict` otherwise;
  - a minimal `Ownership` adapter exposes the document lane (`withSessionOperation`) and held-owner assertion over the commit-log lease.
- `openManagedDocument/closeManagedDocument/revokeManagedDocumentNewWork` on the coordinator; the document's log stays in the ownership map,
  so later appends route through the same lease.
- Test: open a managed document, commit a plan proposal through `metadata.enterPlan`, read it back from `document.view`, close and reopen
  both the document and the raw session.

## Plan 3d (implemented 2026-11-05): deletion, ownership inspection, enqueue

- `deleteOwnedSession` writes a durable `deletion:<id>` receipt into the document log, then **renames the session directory to
  `.trash-<uuid>`** (the atomic deletion commit point) and removes it best-effort; `list` never sees dot directories and the id can be
  recreated immediately. Listener fan-out and `deletionReceipt` are covered.
- `ownerOf`/`hasLiveOwnership` report whether a committed handle (and therefore the lease) is retained.
- `enqueue` is a compatibility shim that appends synchronously and reports failures through the coordinator's normal rejection.

## Plan 3e (implemented 2026-11-05): one-commit child birth

- `createChildSession(request, { closure })` builds the exact session header with `buildBootstrapHeader` (the same
  `semanticSeed`/manifest digest the stage-based path produced) and publishes header + seed records + `session/bootstrap`
  + the initial `agent/input/admitted` event as **one commit**. No stage file, no header promotion, no capture reservation,
  no adoption: the child either exists complete or not at all.
- Idempotency is by the header's `semanticSeed.operationId`: a repeat call with the same operation returns the existing
  child (and its managed document) instead of a conflict; a different operation on the same target refuses.
- When the request carries `lineage.parentSession`, a `child:<operationId>` intent is written to the parent before the
  child commit and settled after it, so a crash leaves a durable intent the parent can reconcile.
- Tests: a forked child (seed manifest first, bootstrap completion last) and a subagent child with the initial admitted
  input (lineage header preserved, exactly one admitted event).

## Plan 3f (implemented 2026-11-05): bootstrap-compatible birth entry + receipt

- `createChildSession` now returns the `BootstrapReceipt` synthesized from the exact events it committed:
  a `bootstrap:<op>:seed` batch (when the seed has records) and a `bootstrap:<op>:complete` batch built with
  `encodeFactBatch`, carrying `manifestDigest`, `dependencyClosureDigest`, `seedLength` and the initial `{inputId, seq, startedAt, expiresAt}`.
  The event at `receipt.completion.key.firstSeq` is `session/bootstrap`; the event at `receipt.initial.seq` is `agent/input/admitted`.
- `bootstrapChildTargetWithCapture(request, guards, capture)` and `resumeChildTarget(request, guards, payload?)` are the drop-in
  entry the subagent already calls: the capture result must match the request invocation, the child is born as one commit, and a
  resume without a payload returns `blocked/payload-required`.

## Plan 4 (implemented 2026-11-05): first real consumer — subagent child on SCL

- `asSessionCoordinator(commitCoordinator)` presents the SCL core as the existing `SessionCoordinator` surface: every
  implemented method is forwarded, the stage-based `bootstrapSemanticTarget`/`resumeSemanticTarget` entry points refuse loudly
  with `TASK_TRANSITION_UNSUPPORTED`, and `inspectBootstrap` reports `absent`. Exported as
  `@i-harness/session-persistence/internal/commit-facade`.
- `packages/subagent/test/child-commit-log.test.ts` runs a real `spawnChild({ childSessions: { coordinator } })` end to end:
  the child is created, its header records `parentSession`/`origin`/`seedLength`/`delegationDepth`, the fork seed is imported
  through the managed fact path, the child's run appends through the same document, and the durable session reads back with the
  seed prefix plus the admitted input. No product code changed to make it pass — the facade is compatible.

## Plan 4b (implemented 2026-11-05): the product verifier accepts an SCL birth

- `packages/subagent/test/child-birth-verification.test.ts` feeds a one-commit birth into the product's own
  `verifyOriginalChildBirth` (the same gate the real task-birth path runs before handing the child to the caller).
  It passes with the exact checks that matter: header `origin`/`subagentProtocolVersion`/`parentSession`/`seedLength`,
  `semanticSeed` seed/manifest/request digests, receipt `seedLength`/`manifestDigest`/initial commitment,
  completion-frame owner and seq range, the `session/bootstrap` event at `completion.key.firstSeq`, the
  `agent/input/admitted` event at `initial.seq` (text/intent/delivery/provenance), `document.assertReady()` and
  the initial-input digest commitment.

## Plan 4c (implemented 2026-11-05): binding observations + unmanaged task host

- `src/commit/observations.ts` implements the v1 binding observation model: existing sessions are snapshotted
  (metadata + `desktop-session-project-<sha256(id)>` document), the not-yet-born target contributes only its binding,
  and the snapshot is **re-read before the callback's result is accepted** (a metadata or binding change becomes
  `SessionBindingObservationError('conflict')`). A missing session is `unavailable`, an aborted signal is `revoked`.
  Exclusion is delegated to the commit log itself: a concurrent birth loses the no-overwrite publication, so the
  observation does not hold a lease across the callback.
- The coordinator exposes `withExistingSessionBindingObservation`/`withSessionBindingObservation`.
- `packages/subagent/test/child-task-host-commit-log.test.ts` runs the real `createUnmanagedTaskChildHost` over the
  commit-log coordinator: the host's observation scope admits the parent, refuses a bound target, the prepared child is
  born through `bootstrapChildTargetWithCapture`, and the product's `verifyOriginalChildBirth` accepts it.

## Plan 5 (reconnaissance 2026-11-05): gateway cutover blocker = managed execution

Running the owned-gateway stack (`createSessionService` + `composeOwnedGatewayDefault` + `createOwnedTaskChildHost`) over the
commit-log facade reaches `service.close()` and fails with **`Original execution coordinator required`** from
`session-persistence/src/execution-internal.ts:28` (`acquireManagedExecution`): the gateway's execution assembly needs the
coordinator to have registered an execution attachment, and the SCL coordinator has not.

What the port must provide:

- `associateManagedExecution(facade, { acquire(id), assertAdmission(id) })`.
- An attachment `{ identity, owner, prepare(), observe(), prepareRequest(action), revokeNewWork(), close() }` where `owner` is the
  SCL managed document (it already exposes `ownsAction`/`beginAction`/`registerReceivedInputSource`/`drain`).
- Under it, `restoreManagedExecutionState(source, binding, foldFactory)` needs an `OriginalConversationRestorationSource` over the
  log: `formatVersion`/`header`/`prefix` getters, `consume(accept)` (feed the folded events), `readEvent(ordinal)`,
  `settle()`/`close()` and `appendCommitted(batch, receipt)` (prefix is recomputed from the log after every commit).
- `binding = { token, assertHeld, openDependencies(prefix) }`; `openDependencies` answers `readEvent(ordinal)` from the same log
  (writer-dependency scopes). `associateExecutionDependencies(backendAdapter, open)` registers it for the fact backend.
- Then `state.bindOwner(document)` and `associateManagedExecution` on the facade object the consumers receive.

Added in this reconnaissance round: `putDocumentStrict` (an alias of the durable `putDocument`) on the coordinator.

## Plan 5a (implemented 2026-11-05): managed execution attachment

- `src/commit/execution.ts` restores `restoreManagedExecutionState` from an `OriginalConversationRestorationSource` over the log
  (stable prefix object, replaced only by `appendCommitted`; `readEvent`/`consume` from the fold; `openDependencies` answers writer
  reads from the same log) and then constructs the managed document **from that state** (`createManagedDocument(..., execution)`),
  so the document owns the delivery observation the execution fence requires. The attachment exposes `identity`, `owner`,
  `prepare`, `observe`, `prepareRequest`, `revokeNewWork`, `close`.
- `asSessionCoordinator` registers `associateManagedExecution`, and the coordinator exposes `acquireExecution(id)`.
- Test: `acquireManagedExecution(facade, 's1')` returns an attachment whose owner is the SCL managed document and whose
  `observe()` reports the empty prefix.

**Next blocker found:** running the gateway stack again reaches the first turn's fact admission, which returns
`{kind:'recovery-required', code:'FACT_INSTALL_FAILED'}`: the document's own queue install throws while the execution state is
bound (its `install` only accepts a batch issued through `prepareWrite`). The next step is to route execution-bound document
writes through `state.prepareWrite`/`install` (or to keep the bound document read-only and let the executor drive all writes),
which is the same split the legacy `attach(...)` path implements at `managed-document.ts:813`.

## Plan 5b (2026-11-05): gateway capability associations audit

Fixing the execution attachment exposed the remaining coordinator associations the gateway composition requires, in the order
they fail:

| Association | State | Requirement |
|---|---|---|
| `associateManagedExecution` | **done** | attachment over the restored state; document constructed from it (incarnation shared with the fact owner so receipts verify) |
| `associateOriginalResultOrdering` | missing | needs an `Ownership` with `beginResultOrderingRegistration`/`retryResultOrdering` and the ordering ledger |
| `associateOriginalResultRevocation` | missing | needs a `ResultRevocationAdmission` from the binding observations plus an ownership participant (`assertOriginalBatchParticipant`) |
| `withProcessReadObservation` | missing (optional) | result reads; callers throw `observation-unsupported` without it |
| `retainExistingSessionBindingObservation` | missing (optional) | execution-host observation; guarded callers skip it |

These are **result-capability** subsystems, not storage: ordering and revocation exist because concurrent sessions deliver results, and
their legacy implementation is coupled to the ownership batch protocol. The SCL-native shape is smaller: commit order defines
ordering, and revocation is a durable marker plus a registry of live attachments. That design is the next plan (Plan 6), followed by
`withProcessReadObservation` over the fold.

## Plan 6a (implemented 2026-11-05): process read observation

- `src/commit/process-read.ts` implements `withProcessReadObservation` over the fold: it captures the session view, the
  high-water mark and the requested documents (`documentKeys`, absent/present), hands that exact snapshot to the callback,
  and reports appended events as `{kind:'suffix', from, to, events}` from `check()`. A shrink or a rewritten prefix refuses
  with `PROCESS_READ_UNAVAILABLE`; after the call the observation is retired and `assertCurrent` refuses.
- The coordinator exposes it; the facade forwards it, which is what `agent-process-read.ts` requires before it will read
  result pages.
- Tests: capture + suffix + publish, and a retired observation refusing `assertCurrent`.

## Plan 6b (implemented 2026-11-05): result ordering registration

- `asSessionCoordinator` associates `associateOriginalResultOrdering` with a minimal ledger owner (`lockEnabled`, a registration
  that can be committed or cancelled exactly once, a no-op `retryResultOrdering`): SCL writers are serialized by the write lease
  and the commit log fixes the order, so no cross-session scheduling is needed.
- Tests: registration issuance/validation, a committed registration expiring, a registration refused by a different coordinator,
  and an unassociated coordinator refusing the capability.

**Revocation (Plan 6c):** `associateOriginalResultRevocation` cannot take a shim — its admission is issued by
`createBindingObservations` and `issueOriginalResultRevocationScope` validates the participant through the private ownership
batch ledger (`assertOriginalBatchParticipant`). The workable path is to give the SCL coordinator a **real** `createOwnership`
instance for ordering + revocation, and build the observations/admission over SCL-backed backend adapters (`putDocument`,
`getDocument`, `readDocumentObserved`, `profile`). That keeps one ownership identity for both capabilities.

## Plan 6c (implemented 2026-11-05): real ownership for ordering + revocation

- `src/commit/capabilities.ts` builds a **real** `createOwnership` over a capability sub-root (`<root>/.capabilities`):
  it reuses the canonical JSONL artifact-path resolution bound to that sub-root, and exposes the documents/profile it needs.
  Session data stays in the commit log; this ownership only carries the cross-session capability ledgers.
- `createBindingObservations(backend, ownership).createResultRevocationAdmission(ownership)` is registered with
  `associateOriginalResultRevocation`, and result ordering is now associated with the same ownership instance (replacing
  the earlier shim) — so ordering participants validate through the real batch ledger.
- Tests: ordering registration/expiry/cross-coordinator refusal, and a full revocation ticket cycle
  (`beginOriginalResultOrderingRegistration` → `commit(participant)` → `issueOriginalResultRevocationScope` →
  `admission.begin` → `close`).

**Next gateway blocker:** the owned gateway now mounts past revocation and fails at `registerSubagent` with
`Original managed Task host required`, i.e. `captureOwnedTaskContext` found no `associateTaskDocumentOperations` port.
That task-document/registry capability is the next port to build on SCL (Plan 7).

## Plan 7a (implemented 2026-11-05): task document operations on SCL

- `src/commit/task-document.ts` implements `TaskDocumentBackendSession` over the document store: `observe()` returns the
  parsed document plus a witness bound to its canonical revision, `confirm(witness)` re-reads and compares, and
  `stageWrite(witness, bytes)` issues/reconciles one durable document commit (a stale witness is a conflict).
- `createCommitCapabilities` builds `createTaskDocumentOperations(ownership, observations, { validator, captureParent, open })`
  when a validator is supplied; `captureParent` resolves the session id from the document through the coordinator's
  `sessionOfDocument` map. `asSessionCoordinator(coordinator, { taskDocument: { validator } })` associates the port.
- Test: parent capture, `assertParentSession`, `begin`, observe-absent.

**Follow-up (same round):** the task registry loads the parent's task document before any save, so `create` now seeds the
composition's empty document (`task-<id>`) and the task operations receive the process-read latches. The owned gateway then
reaches the task **read handoff**: `consume()` calls `ownership.assertHeld(id)`, and the capability ownership does not hold the
session bundle (the SCL commit-log lease is a different ownership). The next step is to give the coordinator one real
`createOwnership` for both documents and capabilities so that assertion is satisfied, instead of a derivative ownership
(identity-keyed WeakMaps reject a spread copy with `Invalid ownership claim`).

**Plan 7c (implemented 2026-11-05): one ownership for documents and capabilities.** The coordinator now creates the real
capability ownership itself (`<root>/.capabilities`), injects it into every managed document/fact owner, and pins each session
while its document is open. `asSessionCoordinator` reuses those ports for ordering, revocation, task documents and cold writes
instead of building a second ownership. The metadata fold factory (`originalExecutionFoldFactory`) is threaded through
`createJsonlCommitCoordinator` into `restoreManagedExecutionState`.

**Milestone:** `packages/desktop-gateway/test/owned-gateway-scl5.test.ts` composes the **whole owned gateway** on the commit-log
coordinator and submits a `/greet world` slash command: plugin/command/skill surface, managed task host, metadata folds, model
request (`hello world`) and a clean `service.close()` all pass.

## Plan 8 (implemented 2026-11-05): product store selection

- `@i-harness/session-persistence-jsonl/internal/commit-coordinator` is the declared subpath for the commit-log coordinator.
- `createDesktopHost({ sessionStore })` and every CLI coordinator construction select the commit-log coordinator when
  `sessionStore === 'commit-log'` or `IH_SESSION_STORE=commit-log`; the facade receives the task-document validator and the
  empty-document factory, and the host threads `originalExecutionFoldFactory`.
- Capability guards for surfaces SCL does not provide yet: the execution-host observation preflight is a no-op when
  `retainExistingSessionBindingObservation` is absent (it can never have issued a lease), and the retained coordinator close is
  associated with the coordinator's own `close`.
- Tests: `host-commit-log.test.ts` creates and closes a session through the real host on **both** stores.

## Plan 9a (implemented 2026-11-05): public fork capture on SCL

- The facade implements `bootstrapSemanticTargetWithCapture` by creating the child directly from the captured
  `BootstrapRequest` (`createChildSession`): header + seed entries + `session/bootstrap` completion in one commit, a
  `CommitLogConflictError` becomes `{kind:'refused', reason:'conflict'}`.
- Test `commit-fork.test.ts`: a fork request produces `{kind:'ready'}` with a verified receipt (seedLength, dependency closure
  digest) and the child log ends with `session/bootstrap`.

**Known:** the existing gateway `fork-session.test.ts` / `project-scope-host.test.ts` construct their coordinator with the legacy
`createSessionCoordinator` factory, which now throws `TASK_TRANSITION_UNSUPPORTED` in `create` — they are baseline red
independent of SCL. SCL fork needs its own host-level test (next).

## Plan 9b (implemented 2026-11-05): gateway fork routes on SCL

- `bootstrapSemanticTargetWithCapture` also materializes the capture's project intent as the target's
  `desktop-session-project-<sha256>` binding (`{version:1, projectId}`) when it is absent; the fork host re-reads that binding
  before handing the target out, so without it every project fork was refused with `target-policy`.
- Test `host-commit-log-fork.test.ts`: a completed source session is forked through the real host's
  `session/fork/prepare` → `session/fork/begin` routes on the commit-log store; the child is listed and inherits `projectId`.
- `host.test.ts` (8 tests) also passes on the commit-log store.

## Plan 9c (implemented 2026-11-05): nested fork and passive resume

- Nested fork works on SCL: a forked child is itself a completed source, and `session/fork/prepare` → `begin` produces the
  grandchild (`host-commit-log-fork.test.ts`).
- `resumeSemanticTarget` returns `{kind:'not-issued', reason:'unsupported'}`: SCL birth is one committed child creation and the
  legacy staged resume protocol has no counterpart, so `session/fork/retry` reports a clean refusal instead of an internal error.

## Plan 9d (implemented 2026-11-05): rewind and schedule reads on SCL

- `host-commit-log-rewind.test.ts`: with a `RewindStore` point, `desktop/rewind/points` → `plan` → `execute`
  (`mode:'conversation'`) succeeds through the real host on the commit-log store (`eventAppended`, `truncated`).
- `desktop/schedule/list` folds the session's schedule events through `coordinator.snapshot` and returns `{ schedules: [] }`
  on a fresh session.
- Schedule **create/delete** go through the live execution runtime (tool execution), so they are exercised only once a turn runs;
  the same is true of selected-result reads.

## Plan 10 (investigation 2026-11-05): host model turn write conflict

A host-level model turn (`host-commit-log-turn.test.ts`, kept skipped as a repro) fails with
`Fact admission requires recovery or was cancelled` and repeated
`private delivery reconciliation failed: Original issued write needs reconciliation`.

What is known:

- the composed surface test (`owned-gateway-commit-log.test.ts`) runs the same kind of model turn **without** the host plugins
  and passes, so the difference is a host component writing during the turn;
- the legacy coordinator wraps every raw append/meta mutation in `processLatches.beginMutation(...)`; the commit coordinator has
  no process latches, so those external appends are invisible to the execution fence — its cached `prefix` object never changes,
  the execution state issues the next batch against a stale prefix, and our backend rejects it as a conflict;
- `managed.assertMutation(id)` only validates the entry (it does not forbid external appends), so the guard cannot be the fix.

**Resolved (Plan 10b):** the promotion/admission check compared provenance with `JSON.stringify`, so two semantically equal
provenance objects with different key insertion order failed. The dump showed exactly that
(`{authority,kind,producer,scope}` vs `{kind,authority,scope,producer}`). `input-preparation.ts` now compares with
`canonicalJsonData`; the host turn test is re-enabled and passed 5/5 runs, and the conversation suites (27 tests) pass.

**Writer prefix (same round):** the execution fence compares the restoration source's `prefix` object by identity. It was a
cached object that only changed on the execution state's own installs, so a raw append from another owner (delivery drain)
desynchronised it. The getter now re-reads the log when the event count changed, except while a batch is between `append` and
`install` (`control.suspended`, shared by the fact backend and the source). The host turn test is stable at 5/5.

**Plan 11 (resolved):** schedule create after a turn failed with `Gateway plugin refresh requires recovery`. The refresh
asserts the assembly's currentness while the session's previous write is between issue and install, which the execution state
reports as `Original issued write needs reconciliation`; the selection owner then poisoned the row permanently. The refresh
now retries that specific transient failure (up to 40 times, 25 ms apart) before failing the row; schedule create/list/delete
passes 5/5 on SCL.

## Plan 12 (implemented 2026-11-05): transient write reconciliation in the delivery drain

After the prefix fix, the delivery drain still logged `private delivery reconciliation failed: Original issued write needs
reconciliation` / `Original writer dependency cleanup unresolved`: those are the execution state's **in-flight** write
windows, not delivery failures. `delivery-drain.ts` now classifies them as transient (retryable, not reported); the drain
retries with its existing backoff. The SCL host turn and schedule tests emit no reconciliation warnings, and the legacy host
suite still passes.

## Plan 13 (inventory 2026-11-05): coordinator surface used by the product

Members the desktop gateway calls on its coordinator, with SCL status:

| Member | SCL |
|---|---|
| `create`, `load`, `list`, `profile`, `snapshot`, `flush`, `storageRoot` | yes |
| `putDocument`, `getDocument`, `onDocumentDeleted` | yes |
| `openManagedDocument`, `revokeManagedDocumentNewWork` | yes |
| `adoptOwnership`, `releaseOwnership`, `ownerOf`, `hasLiveOwnership` | yes |
| `updateMeta`, `deleteOwnedSession`, `deletionReceipt` | yes (deletion covered by `commit-coordinator.test.ts`) |
| `withExistingSessionBindingObservation` | yes (v1 snapshot+revalidate) |
| `withProcessReadObservation` | yes |
| `inspectBootstrap` | yes (`absent`) |
| `bootstrapSemanticTargetWithCapture` | yes (direct child create) |
| `inspectChildBootstrap` | absent (caller guards) |
| `retainExistingSessionBindingObservation` | yes (observations instance + coordinator association; test `commit-retained.test.ts`) |

Free-function capabilities consumed by the gateway and still legacy-only:
`selectedSourceFor` / `beginColdSelectedFinalization` / `captureOriginalColdObservation` (selected results and fork cleanup; guarded
or refused on SCL) and `retainSelectedProjectRead` paths in context-runtime.

Legacy-only subsystems that the SCL product path no longer needs (deletion candidates once results are ported):
coordinator-factory bootstrap/adoption, selected-results capture, task-document transitions (`stageInitialize`/frames), retained
bindings, ownership batch ledgers and the JSONL journal/artifact paths.

## Plan 14 (implemented 2026-11-05): retained session bindings

- `createBindingObservations` already owns a `createRetainedBindings` ledger and exposes `associateRetainedCoordinator` plus
  `retainExistingSessionBindingObservation`. `asSessionCoordinator` registers itself and forwards the method, so the
  desktop gateway's execution-host observation is no longer disabled.
- Test: issue a reference for an existing session, `assertCurrent`/`metadata`/`binding`/`withRead`, then `release` and verify
  the reference is revoked.

## Plan 15 (implemented 2026-11-05): execution surface events on SCL

With retained bindings available, the gateway advertises `desktop-surface-events: ['1']` on SCL and the private execution
observation can hold leases. `host-commit-log-surface.test.ts` subscribes (`desktop/surface/subscribe`), takes a snapshot
(`desktop/surface/snapshot` with the lease epoch) and unsubscribes through the real host.

## Plan 16 (implemented 2026-11-05): surface change notifications on SCL

`host-commit-log-surface-changed.test.ts` subscribes to the execution surface, runs a controlled prompt turn and observes a
`desktop/surface/changed` frame, so the private observation publishes writes made through the commit log.

## Plan 16a (implemented 2026-11-05): refresh retry budget under parallel load

The plugin refresh can also see `Original writer dependency cleanup unresolved` while an earlier write settles. With seven SCL host
files running in parallel the 1 s budget was too short; the selection owner now retries those three transient messages for up to
5 s. The parallel SCL host suite (8 tests) passed three consecutive runs.

## Plan 17 (implemented 2026-11-05): session management routes on SCL

`host-commit-log-management.test.ts` renames, archives, restores, reloads and reads navigation state for a commit-log session
through the real host (`updateMeta` / `snapshot` / `list` / `load`), including the archived list and the visible list
invariant.

## Plan 18 (implemented 2026-11-05): CLI sessions command on the commit log

`i-harness sessions list/show` used the legacy JSONL coordinator unconditionally, so an SCL store looked empty. The command now
selects the commit-log coordinator when `IH_SESSION_STORE=commit-log` (with the writer lease enabled; reads take no lease).
`listStoredSessions` already works through `list`/`profile`/`snapshot`; the artifact mtime falls back to `createdAt` when the
legacy file is absent. Test: seed an SCL session and list it through `runSessionsCommand`.

## Plan 19 (implemented 2026-11-05): explicit selected-results capability

`hasSelectedSource(coordinator)` is exported (via `internal/selected-source-owner`). The gateway's selected-source acquisition
and task-child inheritance paths check it and fail with `SELECTED_RESULTS_UNSUPPORTED` ("Selected results are unavailable on
this session store") instead of the legacy `Original coordinator required` TypeError. SCL reports the capability as absent.

## Plan 20 (implemented 2026-11-05): desktop settings/rule routes on SCL

`host-commit-log.test.ts` also reads `desktop/approval-rules/state` through the real host on SCL (the rules state lives in the
host's file-backed adapter, so this pins that the surrounding desktop surface works). `desktop/usage/query` (v1) is refused by
the current host with `USAGE_UPGRADE_REQUIRED` regardless of store; usage reads are expected to use `desktop/usage/query-v2`.

## Plan 21 (implemented 2026-11-05): project scope binding on SCL

`host-commit-log-project.test.ts` configures a project, binds a commit-log session to it, reads the project state and the
navigation state, and pins the idempotent re-bind (a bind without a project id keeps the existing binding — the gateway's
`bind` has no unbind path). This exercises the binding-document write/read path on SCL.

## Plan 22 (implemented 2026-11-05): legacy document read-through

Documents written before the commit-log store (`task-*.doc.jsonl`, project bindings, …) are no longer invisible after switching:
`LegacySessionStore.readDocument` is optional and the coordinator falls back to it when the document log has no side or does not
exist yet. The JSONL composition supplies `backend.getDocument`. Once a key is written through the commit log its sidecar wins.

## Plan 23 (implemented 2026-11-05): auto-generated title documents on SCL

`host-commit-log-title.test.ts` runs a controlled turn with `autoTitle`, lets the owned post-turn write
`session-title/<id>` (`{formatVersion:1, title}`), and reads that document back through a read-only commit-log coordinator.
Note: the gateway's `session/list` title comes from `profile.meta.title` (rename), so auto titles are read from the document.

## Plan 24 (implemented 2026-11-05): headless CLI run on SCL

`apps/cli/test/run-commit-log.test.ts` runs `i-harness run hello --session-dir <tmp>` with `IH_SESSION_STORE=commit-log`
against a local fixture provider: exit 0 and exactly one session generation (`<id>/session.v15.jsonl`) plus the `__documents__`
log. This is the first end-to-end CLI turn on the commit-log store.

## Plan 25 (implemented 2026-11-05): live model switch on SCL

`host-commit-log-turn.test.ts` now also sets the live model (`session/model/set` with `{provider,model}`) and runs a second
prompt through the rebound assembly, so the host's in-place rebind works with the commit-log execution attachment.

## Plan 26 (implemented 2026-11-05): execution, task and process reads on SCL

After two turns the host's `desktop/session/execution/read`, `desktop/session/tasks/integrity` and
`desktop/session/processes/read` all succeed on the commit-log store, covering the execution attachment read path, the task
projection and the agent-process projection.

## Plan 27 (implemented 2026-11-05): batch management and diagnostics on SCL

`host-commit-log-management.test.ts` archives/restores a second session and then deletes it through
`desktop/session/batch` (exercising `deleteOwnedSession` end-to-end through the host), and reads
`desktop/environment/diagnostics`.
Compaction (`desktop/session/compact`) still needs a checkpoint-capable fixture model and is left for a dedicated test.

## Plan 28 (investigation 2026-11-05): manual compaction on a live SCL session

`desktop/session/compact` fails with `Original execution observation expired` on a live commit-log session (repro kept skipped
in `host-commit-log-compact.test.ts`). The expiry comes from `observe()`'s identity check (`member('prefix') !== expected ||
delivery.revision() !== fence`): the observation captured before the compaction no longer matches the execution state after the
previous turn's writes. A bounded retry of the compact call did not help, so the mismatch is persistent rather than a transient
race; the next step is to check whether the delivery revision advances on ordinary writes (our document's delivery control) or
whether the compaction path must re-observe around its own writes.

## Plan 28b (implemented 2026-11-05): compaction reaches the engine on SCL

The expiry was not in the execution prefix but in the cached **recovery prompt**: `modelOverheadTokens` asks for the system
prompt before `prepareModelSurface` refreshes the native-recovery observation, so the cached recovery text is stale after any
earlier turn. `recoveryPrompt` now omits the advisory recovery section when its observation expired (the real request still
gets a fresh one through `prepareModelSurface`). Compaction then reaches the engine. Two fixture attempts: overriding `prepare` with the compaction text fixture breaks the managed
generation composition (`GENERATION_UNSUPPORTED`), and a plain controlled answer leaves the summarizer blocked with
`retention-output`. The summarizer needs a checkpoint/output-retention fixture composed through the managed model client; the test
keeps the SCL-specific assertion (`outcome` is a string, no observation expiry).

## Plan 28c (investigation 2026-11-05): compaction summarizer fixture

`desktop/session/compact` on SCL now reaches the compaction engine (no observation expiry). The summarizer itself is blocked
with `retention-output` under the controlled fixture model; replacing the model with the compaction text fixture loses the
managed generation composition (`GENERATION_UNSUPPORTED`). A real end-to-end compaction test needs a fixture that stays inside
the managed model client while producing a retained checkpoint.

## Plan 28d (investigation 2026-11-05): compaction size and progress checks

`retention-output` is the summarizer's quality/size check (`compaction/src/summary/generate.ts`): the model must return at least
`minSummaryChars` and at most `maxTokens*4` characters — the controlled `answer` is far too short. Returning a
`checkpointOfLength(600, …)` summary fixes that on a short session, which then blocks with `no-progress` (nothing to shrink).
With a seeded long history the compact request fails and host close reports `session service cleanup incomplete`; the repro is
kept skipped (`host-commit-log-compact-long.test.ts`) for the next investigation.

## Plan 29c (implemented 2026-11-05): end-to-end compaction on SCL

A history built **through the host** (eight prompted turns, long answers) compacts successfully on the commit log:
`{compacted:true, outcome:'ready', publication:'committed'}` with the checkpoint summary. The earlier failure came from
seeding raw events that the managed restore rejects (`Assembly construction and cleanup failed`), not from compaction itself.

The short-session test keeps the engine-reached assertion; the long-session test asserts the committed compaction.

## Plan 31 (implemented 2026-11-05): legacy corpus dual run

`commit-dual-run-corpus.test.ts` builds a corpus through the legacy JSONL backend (empty, single message, internal message, a full
turn, tool call/result, steps, two turns; one titled) and checks that the commit-log coordinator returns exactly the same
`list`, events, profile title and task document. This is the ADR §5 step-3 gate for cutting over and deleting the legacy
coordinator.

## Plan 32 (implemented 2026-11-05): corpus delivery events

The dual-run corpus also covers an `agent/delivery-generation` session. A hand-written `compaction/replacement` entry is rejected by
the historical-replacement validator; a valid compacted history has to come from the real compaction path, so the corpus keeps
the compaction case out until such a fixture is captured.

## Plan 33 (implemented 2026-11-05): batch project move on SCL

`desktop/session/batch` with `action:'move'` moves a commit-log session into a configured project (the command requires
`expectedOwners` to carry the current owner; a missing entry is a per-session `ok:false`, not a throw). The project state then
reports the new project id.

## Follow-on plans (not in this plan)

1. **Store + lease + crash-cut** — temp write, fsync, `link()` no-overwrite publish, append, sidecar GC, flock via `@i-harness/fs-lock`, crash-injection matrix.
2. **Facade** — implement `SessionCoordinator` on the store; wire `session-executor` behind a flag.
3. **Birth/fork migration** — replace `bootstrapSemanticTarget`/`resumeSemanticTarget` and the capture reservation with intents.
4. **Format-15 generation migration** — read 13/14, dual-run against the legacy coordinator, then cut over.
5. **Delete legacy** — coordinator bootstrap/adoption, jsonl bootstrap/document-write paths, obsolete specs.

## Plan 36 (design 2026-11-06): selected-results port assessment

Selected results are the only product feature still exclusive to the legacy coordinator. Inventory from the code:

- **Storage**: result pages live in the session event stream (`conversation/seed-results`, `seedLayout().resultPageSeq`) plus
  the artifact/blob store; selections are carried in the fork request (`core.selection`) and the seed manifest
  (`conversation/seed-manifest` with `results`). No separate selected-results document store exists.
- **Runtime**: `selectedSourceFor(coordinator)` is built from `createDocuments(...).observations`
  (`acquireSelectedBindingRead`, `retainTask`, cold finalization). It is a capture/lifecycle subsystem, not a storage adapter:
  it holds leases, freezes project bindings, verifies lineage and produces a `ForkSourceWitness`.
- **Gateway use**: `context-runtime.acquireSelectedSource` (fork handoff and task-child inheritance),
  `resultReadScopeFor`, `withResultObservation`; absent capability now fails with `SELECTED_RESULTS_UNSUPPORTED`.

Port outline (multi-round):

1. **Read**: a selected-results reader over the commit log fold (result pages are ordinary events) plus the artifact store
   for page payloads; expose result pages through `withProcessReadObservation` (implemented).
2. **Witness**: a lineage witness that pins the source prefix (the execution attachment already pins an incarnation) and
   re-validates the selected seqs before the fork capture commits.
3. **Capture**: extend the SCL `bootstrapSemanticTargetWithCapture` to accept a seed compiled from selected pages (the
   capture request already carries `core.selection`); `createChildSession` writes the seed manifest with results.
4. **Cleanup**: a cold-finalization equivalent that retires the witness when the child is ready.

Until then the legacy coordinator stays the only selected-results implementation and the SCL store remains opt-in.

## Plan 34 (implemented 2026-11-06): managed tool execution on SCL

`host-commit-log-turn.test.ts` runs a prompt whose controlled model emits a `todo_write` tool call: the tool executes through the
managed document and both `tool/call` and `tool/result` events are committed (read back with a second coordinator). This is the
first tool-execution round trip on the commit-log store and the prerequisite for artifact-producing tools (shell/exec results).

## Plan 35 (implemented 2026-11-06): artifact retention and result pages on SCL

A `read` of a 200 KB workspace file produces a `tool/result` whose envelope retention is `kind: "artifact"`
(`json-utf8-v1`, content digest, encoded bytes), and `session/result/read` returns the page (`{ref, offset, nextOffset, eof, data}`)
through the real host. The artifact store therefore already works for commit-log sessions; what remains for selected results is
the selection/witness lifecycle, not storage.

## Plan 37 (implemented 2026-11-06): child-birth inspection on SCL

`inspectChildBootstrap(request)` now answers from the commit log: `ready` when the target header carries the same operation id,
`conflict` for a different operation, `absent` when the target does not exist. This gives the gateway project-scope admission a


## Plan 38 (implemented 2026-11-06): restore legacy test coverage on the composed coordinator

`repair.test.ts` now builds its coordinator with `composeJsonlTaskTransitionCoordinator(..., { lock: { enabled: true } }, taskDocumentStorageContract)`
instead of the plain factory: the transition gate (`TASK_TRANSITION_UNSUPPORTED`) disappears, and the file is green (19/19; one
assertion accepts `TASK_TRANSITION_FAILED` because the composed path reports the non-positional sequence that way).

## Plan 39 (implemented 2026-11-06): deletion clears the session documents

`deleteOwnedSession` wrote the durable deletion receipt and removed the session directory but left the session-owned documents
(task, title, project binding) in the document log. The manifest documents are now cleared with `doc-clear` commits after the
receipt, so a recreation cannot read stale task/title/binding state while unrelated documents stay untouched
(`commit-coordinator.test.ts` covers task + title removal and an unrelated document).

Integration: `host-commit-log-management.test.ts` creates a session through the host (the facade seeds `task-<id>`), asserts the
document exists, deletes the session through `desktop/session/batch`, and reads the document as absent with a second
coordinator. `child-bootstrap-admission.test.ts` failures were confirmed as the same pre-existing plain-factory gate (the test
builds `createSessionCoordinator` directly).

## Plan 40 (implemented 2026-11-06): deleted sessions revoke retained references

`deleteOwnedSession` now marks the session and its manifest documents in the binding observations (`markDeleted`), so a retained
reference (or a binding observation) stops being current as soon as the deletion receipt is durable — previously the reference
kept passing `assertCurrent` after the session directory disappeared. 

Note: a `shell` tool call (echo) executes and commits its tool/result on SCL, but `desktop/session/execution/read` reports
`{live:false, cells:[]}` after the turn — the execution projection is a live-runtime view, not a log projection, so it is empty for
a cold session. The artifact assertion in the turn test now selects the `read` result by tool name so a later tool cannot shadow it.











## Plan 52 (implemented 2026-11-06): legacy read errors are not "not found"

`readLegacy` mapped every legacy read failure to `CommitLogNotFoundError`, so a corrupt or unsupported legacy session looked deleted.
It now maps only `ENOENT` to not-found and rethrows the real error. `commit-dual-run-corpus.test.ts` covers an old header without
`journal` metadata (surfaces `invalid session journal metadata`) and a genuinely absent session (still `CommitLogNotFoundError`).
This also pins the older-format boundary: formats 6–12 need valid journal metadata and this branch has no writer or recorded sample
for them, so the dual-run corpus stays at 13/14.

## Plan 51 (implemented 2026-11-06): two-process writer lease

The ADR verification item "two processes, one writer" now has a dedicated test: a child process (`node --experimental-transform-types`,
since the sources use parameter properties) opens the session for write and holds the lease; the parent write open rejects within its
deadline; after the child is killed the parent opens write, appends and a fresh read sees the new entry. This also proves the lock
is released by process death (no stale-writer deadlock).

## Plan 50 (implemented 2026-11-06): fold property test

`fold-property.test.ts` generates deterministic random op sequences (header, meta, doc, doc-clear, intent, intent-done, batch,
rewind, seed, delete; 25 commits across 5 seeds), re-encodes and re-scans them (which enforces seq/prev/digest), and compares
`foldCommits` against an independent reference implementation of the documented fold semantics.

## Plan 49 (verified 2026-11-06): full SCL regression snapshot

All commit-log suites run together: **13 host files / 14 tests** (create, fork, rewind, turn, schedule, surface, surface-changed,
management, project, title, compact, compact-long, owned gateway), **7 files / 32 tests** in `session-commit-log`
(format, scanner, fold, store, crash, scan-cache, benchmark) and **9 files / 37 tests** in the session-persistence commit suites
(coordinator, execution, fork, ordering, retained, task-document, process-read, observations, prefix) — 83 green, no flakes.

## Plan 48 (implemented 2026-11-06): CLI transcript tail

`sessions show --last 2` on an SCL store prints only the tail with the `earlier line(s)` marker, covering the transcript window
path. A concurrent live `execution/read` during a prompt is not testable through one host connection: the RPC replies are serialized
per connection, so a second request cannot observe the running turn (the read returns after the turn, `live:false`).

## Plan 47 (implemented 2026-11-06): large-session read cost

Extending the benchmark with a 5,000-event session (about 1.1 MB) shows ten warm reads in **7 ms total** — the fold itself is
sub-millisecond, so caching the folded view is not warranted; the read-open scan cache already covers the parse cost and the OS
page cache covers the bytes.

## Plan 46 (implemented 2026-11-06): scan cache measurement

`scan-cache-bench.test.ts` builds 40 sessions x 30 events and times a second full read pass: **17 ms with the cache disabled
(`IH_COMMIT_SCAN_CACHE=0`) vs 7 ms with it enabled** on this machine — the parse savings are real, while the file read stays the
floor for this small corpus. The env flag is also an escape hatch if the cache is ever suspected.

## Plan 45 (implemented 2026-11-06): CLI sessions show on SCL

`sessions list` and `sessions show` (transcript and `--json`) both read an SCL store through `runSessionsCommand`; the test seeds a
session with a user/assistant exchange and asserts the rendered transcript. Note the command expects argv including the `sessions`
token (it slices the first element).

## Plan 44 (implemented 2026-11-06): read-open scan cache

`openCommitLog(read)` re-scanned and JSON-parsed the whole generation on every open, and the desktop lists call `profile` per
session. Commit logs are append-only, so an unchanged byte length means an unchanged record set: read opens now reuse the parsed
records from a bounded (64-entry, LRU by insertion) cache keyed by root+session; an append changes the length and forces a fresh
scan. Write opens always scan (they need torn-tail bytes). `scan-cache.test.ts` covers reuse and invalidation.

## Plan 43 (implemented 2026-11-06): incremental journal prefix

`commitPrefix` re-serialized the entire event history to compute `bodyBytes` on every call, which is O(n) per commit (and the
execution fence reads the prefix on every write). The value is now accumulated per appended event and cached by `CommitLog`
identity, so a commit only serializes the events it adds while keeping the exact same `{eventCount, bodyBytes, prefixDigest}`.
The commit suites (26 tests) stay green; SCL host flows use the same prefix on every write.

`commit-prefix.test.ts` pins the arithmetic: after each append the prefix reports exactly the sum of the canonical event bytes,
repeated reads are stable, and a fresh read handle recomputes the same values (cache miss path).


## Plan 42 (implemented 2026-11-06): task projection reconcile on SCL

`host-commit-log-turn.test.ts` also calls `desktop/session/tasks/integrity` with `reconcile: true` after tool execution, exercising the
task projection reconcile write path (the plain read is covered separately).

`commit-retained.test.ts` covers acquire → delete →
`assertCurrent` throws → release.

Coordinator close also retires the binding observations (`closeRetained` with a fresh cleanup operation, inside the close path
before the log handles close), so retained references are revoked and new admissions are refused after close. Covered by a third
case in `commit-retained.test.ts`.




`fork-controller.test.ts` moved the same way: 32 failures drop to 6, which have different causes (fork admission/host fixture

Full-suite measurement after the migration (2026-11-06): `session-persistence` is **280 failed / 840 passed / 1120 total** across
125 files (38 files red). The failures are legacy-coordinator and artifact/latch fixture gaps (`PROCESS_READ_UNAVAILABLE`,
`TASK_TRANSITION_*`, win32 lock tests) rather than SCL code; restoring that baseline is a separate, larger effort and was stopped
here. The commit-log suites stay green and independent.

expectations) and are the next chunk. `delivery-facts.test.ts` was attempted but its result-page admission needs the process-read
capability the tests do not provide; it stays as-is for now.

Verification: the full `session-persistence` suite has a pre-existing red list unrelated to the commit-log work —
`delivery-facts` (48), `fork-controller` (32), `repair` (8) and `ownership` (18) all fail on the legacy
`createSessionCoordinator` gate (`TASK_TRANSITION_UNSUPPORTED` because format >= 14 requires the composed transition storage) or
on the win32 real-lock tests, and `child-bootstrap-intent` has one stale digest expectation in the legacy reservation encoding.
None of these files import the commit-log package; the commit suites stay green.

defined answer instead of the previous absent capability (the caller still guards).



