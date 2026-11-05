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

## Follow-on plans (not in this plan)

1. **Store + lease + crash-cut** — temp write, fsync, `link()` no-overwrite publish, append, sidecar GC, flock via `@i-harness/fs-lock`, crash-injection matrix.
2. **Facade** — implement `SessionCoordinator` on the store; wire `session-executor` behind a flag.
3. **Birth/fork migration** — replace `bootstrapSemanticTarget`/`resumeSemanticTarget` and the capture reservation with intents.
4. **Format-15 generation migration** — read 13/14, dual-run against the legacy coordinator, then cut over.
5. **Delete legacy** — coordinator bootstrap/adoption, jsonl bootstrap/document-write paths, obsolete specs.
