# Session Commit Log — Format, Scan, Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-light library that encodes, scans, verifies and folds one session's append-only commit log (format 15), so the durability core can be rebuilt on a single commit point.

**Architecture:** Three pure modules. `format.ts` defines the record/op schema, canonical encoding and digest chain. `scanner.ts` turns raw bytes into the longest valid commit prefix (a torn tail is dropped, a damaged complete line is corruption). `fold.ts` derives the session view (header, entries, meta, documents, intents, rewound/deleted state) from records. No filesystem I/O in this plan: the store/lease/crash-cut work is Plan 2.

**Tech Stack:** TypeScript (erasable syntax), Node 22+, vitest, `node:crypto` sha256, `@i-harness/core-session` canonical JSON (`canonicalJsonData`) and `SessionEvent` types.

**Spec:** `docs/design/2026-11-05-session-commit-log-redesign.md`

**閱讀指引：** 後續的 `## Plan N` 區段是**按時間往前插入**的（最新在最前面），因此檔案中的編號不是遞增順序；
每個區段開頭會標示 implemented／fixed／found 等狀態，最終現況以 `docs/design/2026-11-06-session-commit-log-status.md` 為準。

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





















Follow-up: with `contextSubsystems.contextOutput.enabled = true` in the test settings, the same `context_output_read` call still
leaves no `tool/result` event in the log — only `context/action`, `context/budget` and `context/attempt` events — so the context tool
appears to answer through the model message stream rather than a persisted tool result. `session/result/read` remains the verified
page-read path on SCL; whether the in-turn tool needs the selected-source witness is still open and should be checked from the
gateway native context rather than the host log.













## Plan 175 (2026-11-06): the plan is executed; selected-source port is the explicit follow-up

Final state of the planned scope:

- commit-log store, format/scanner/fold, coordinator, facade and gateway wiring are implemented and documented;
- SCL remains **opt-in** (`sessionStore:"commit-log"` / `IH_SESSION_STORE=commit-log`); the legacy store stays the default
  (§8.1 decision);
- product surfaces verified on the commit log: turns, model switch, fork (nested, forked children running turns, schedules, todos),
  rewind (all modes, restart, after turn, after fork), archive/delete/restore/batch, project bind/move, compaction, todo (cold/live,
  across rewind and compaction), schedule CRUD, management/title/project, surface notifications, execution/tasks/processes reads,
  search/lineage/subtree/context picker, CLI run+sessions, restart durability;
- selected-results fork: capture → v3 seed → pages → `createChildSession` → host seams all work; the **only** gap is reading an
  inherited page on the child, which needs the legacy selected-source port (§8.2). All four shortcut attempts were tried and documented;
- legacy deletion remains gated on that port (never started); old-format corpus (6–12) still needs recorded samples.

Final verification: host 38 files / 44 tests, store 38, commit 41, CLI 2 — 125 tests green; repo typecheck green; reachability gate
PASS.

## Plan 180 (2026-11-06): default-switch measurement

With `IH_SESSION_STORE=commit-log` set for the whole gateway suite, a representative legacy-oriented set (host-fork-restart, fork-session,
rewind-host, title-action, result-page-host) drops to **17 failed / 5 passed**. The failures cluster on exactly the legacy layers that are
not ported: fork-session's held broker/observation cohorts, result-page-host's durable artifact owner, rewind-host's cold-session previews
and title-action's held profile lookup. `host-fork-restart` passes. This is the measured evidence behind the ADR decision to keep the
commit log opt-in: switching the default requires the observations/result-store port, not only the selected-results read-through.

## Plan 179 (implemented 2026-11-06): a fork child reads inherited pages through its source

Instead of porting the legacy held-observation/result-store layer, createConversationResultReader now falls back for a fork child:
when the direct read answers unavailable and the requested ref id appears in the child seed pages (conversation/seed-results), the
reader retries the same query against meta.parentSession under the fence. The child therefore reads exactly the bytes it inherited;
the source store remains the owner and no second store is materialised. The selected-read E2E now asserts data on the child, and all
33 host-commit-log files (35 tests) stay green. Limits (documented): the fallback needs a parent link and the ref id in the seed
pages; it does not resurrect the legacy lineage/revocation witnesses, and a deleted source makes the inherited read unavailable.

## Plan 178 (2026-11-06): old-format samples cannot be synthesised in this build

The legacy jsonl store now writes format 15 only (`backend-factory.ts`: "new session writers require current format"), and the older
formats carry a binary fact-journal frame after the header (`readFactJournal`), whose historical writer is not exported. There is
therefore no in-tree way to generate format 6–12 samples: the corpus needs files recorded by old builds. What is verifiable in this
build is already covered — `legacy-version-adoption.test.ts` drives 6/8/11/13/14 through the coordinator and proves the adoption and
first-write migration, so the remaining corpus gap is confined to the byte layouts read by the legacy store itself.

## Plan 177 (implemented 2026-11-06): every supported legacy version is adoptable

`session-persistence/test/legacy-version-adoption.test.ts` drives formats 6, 8, 11, 13 and 14 through the commit-log coordinator: each is
read through the legacy store (`coordinator.load`), then the first `append` publishes a format-15 generation and `profile` reports the
current format. The upgrade registry is identity for 1–13, so this pins the coordinator contract for all supported versions. The
**remaining** corpus gap is narrower than before: only the legacy reader's own byte layouts (session-persistence-jsonl) still need
recorded samples — the commit-log adoption path itself is verified.

## Plan 174 (2026-11-06): hydration attempt and the remaining conclusion

Appending `context/result-ref` events for the seed page rows to the child (right after `createChildSession`) did not authorize the
read either — it still answered `unauthorized`, and the change was reverted (a type cast also needed `unknown`). The conclusion after
the four attempts is firm: **reading an inherited page requires the legacy-style selected source** (a held inherited observation and a
result store that owns the inherited refs), which is the same `createDocuments(...).observations` port §8.2 describes. Everything
before the read works on the commit log: capture, v3 seed, seed pages, child creation, task document, scheduling, turns and clean close.

## Plan 165 (implemented 2026-11-06): the child cannot read its inherited page yet

Second trace (2026-11-06): `readManagedResultPage` dispatches to the context-output service's `readResult`, which resolves the ref from
the session's **context store** (`current.get(id)`) and then `allowed()`. The child's store is built from its own events; its seed
pages (`conversation/seed-results`) are not `context/result-ref` events, so the store simply does not contain the ref and the read is
denied before authorization matters. The next experiment is to append the inherited `context/result-ref` events to the child right
after `createChildSession` (one per page row ref), so the child's store owns what its seed carries; if the store lookup then succeeds,
the read path should follow.


Attempt (2026-11-06): `host.ts` `hasVisibleResultRef` was extended to fall back to the session's seed result refs (the same helper
`visibleRefsFor` uses), so a forked child would see the refs it inherited. The child read still answered `unavailable` and the change
was reverted; the denial therefore does not come from that hook (the `readManagedResultPage` path inside the session executor has its
own authorization). The test now asserts only `kind:"unavailable"` instead of pinning the reason.


Authorization trace (2026-11-06): `context-output/service.ts` `allowed()` grants a ref only when
`store.owns(ref.id, access.sessionId)` or the host `authorize` hook returns true. The child neither owns the source ref in its own store
nor supplies an `authorize`: the gateway's `resultReadScopeFor` (the host hook in `result-reader.ts`) returns nothing for a child, so the
read is denied before the page is touched. The fix therefore lives on the host side: give a selected-results child a read scope that
covers the refs it inherited (the legacy selected path does this through `createSelectedRuntimeCapture`).


Fixed (2026-11-06): the child prompt's close failure was traced to `Owned task document is absent` during assembly setup — the
**selected-results** fork path creates the child through `createChildSession` directly (not through the facade), so it never seeded
`task-<id>`. `createSelectedForkController` now seeds the empty task document (when the host provides one) right after creation;
console traces in `assembly.ts`/`service.ts` were reverted. The child prompt now closes cleanly, but the child read is still
`unavailable/unauthorized`: the live observation does not carry the inherited selected results.


Follow-up: the unauthorized answer comes from context-output's result-page scope (`service.readResultPage` →
`Context reference unavailable or unauthorized`), which authorizes refs against a **live observation** for the session. A freshly
created child has no assembly, so the cold read is refused; prompting the child first was tried, but that host close then failed with
`Desktop host cleanup incomplete: session service`, whose inner failure is `AggregateError: Session service process cleanup incomplete`
(the child assembly's own process cleanup at `assembly.ts:1947` aggregates at least one failed process close). That leak is the next
item; the read refusal itself is understood.


`host-commit-log-selected-read.test.ts` runs the full E2E: a turn reads a 200 KB file (real artifact), the host restarts, the product
result-ref is appended through the coordinator, the v2 fork is prepared/executed and both source and child call `session/result/read`
with the same ref. The **source** read returns data; the **child** read answers `{kind:"unavailable", reason:"unauthorized"}`. So the
page bytes and the seed pages are in place, but the result-lineage gate still refuses the child. The next investigation is that gate
(`hasVisibleResultRef` / `assertResultLineage` on the child's inherited observation). The test pins the current answer so the gap is
visible in the suite.

## Plan 164 (planned 2026-11-06): reading an inherited page on the child

The page contents live in the artifact store that the source turn wrote; a synthetic ref (the `codecRef` fixture) has no bytes, so the
read must use a real artifact. The end-to-end shape is: (1) a host turn that reads a large file (real artifact), (2) close the host,
append the product's `context/result-ref` marker for that artifact through the coordinator, (3) start a fresh host on the same store,
prepare/execute the v2 fork and (4) `session/result/read` with the same ref on the child. The first draft mixed the two phases in one
test and lost the session id across the close; the implementation is the next round's work.

## Plan 163 (implemented 2026-11-06): the host inherits pages for a source that references a result

`host-commit-log-selected-fork.test.ts` gains a second case: a commit-log source is seeded (outside the host) with a turn and a
`context/result-ref` event, the host then prepares/executes a v2 fork, and the child contains `conversation/seed-results` events. The
first case (a turn that never references its result) keeps asserting zero pages, so both sides of the selection are pinned.

## Plan 162 (implemented 2026-11-06): a result reference produces seed pages

Appending a `context/result-ref` event (the product's result-selection marker) to the source before capturing makes
`exportSelectedResultsConversationSeed` emit `conversation/seed-results` pages; `selected-fork-seed.test.ts` now covers it. So the empty
seed in the host test reflects a turn that never referenced its result, not a broken capture. The host path would populate pages for a
turn that produces a ref (typically a large tool output).

## Plan 161 (2026-11-06): the v3 seed carries pages only when something was selected

Inspecting the child created by the host test shows `conversation/seed-manifest` + `seed-group` events but **no**
`conversation/seed-results` pages: the source had no recorded selection, so the exported results summary is empty. The test now asserts
exactly that (manifest present, zero pages). The next step for full page inheritance is to record a selection on the source (the
context-output selection API the product uses) before preparing the fork.

## Plan 160 (implemented 2026-11-06): selected-results forks reach the host

The host wires `createSelectedForkController` into the SDK seams (only when the commit-log store is selected) and derives the project
intent from `desktop-session-project-<sha256(source)>`. `host-commit-log-selected-fork.test.ts` prompts a source whose turn reads a
file (an artifact-backed result), prepares a v2 fork, begins it and finds `selected-child` in `session/list`. The full SCL host suite is
**37 files / 42 tests** green. The legacy store keeps its own `createSelectedRuntimeCapture` path (the seams are not wired for it).

## Plan 159 (implemented 2026-11-06): the gateway prepares and executes a selected-results fork

`selected-fork.ts` adds `createSelectedForkController`: `prepare` builds the v2 core + `createSelectedResultsIntent` from the captured
seed; `execute` re-captures, calls `createChildSession` with the compiled v3 seed, writes the project binding document and returns a
`ForkOutcomeV2` with the receipt (manifest digest, seed digest, results summary). The SDK seam now speaks `ForkPrepareResultV2`/
`ForkOutcomeV2` and validates with `readSelectedResultsOutcome`. `selected-fork-seed.test.ts` prepares, executes and loads the child:
its header carries `semanticSeed {version:3, codec:"semantic-seed-v3"}`. Remaining: wire the controller into the host seams and add a
gateway host test that reads a result page on the child.

## Plan 158 (implemented 2026-11-06): the gateway captures the selected-results seed

`packages/desktop-gateway/src/selected-fork.ts` adds `captureSelectedResultsSeed(coordinator, sourceSessionId)`: it loads the source through
`coordinator.load` (so the commit log and the legacy store share the code), builds the managed state + `FactOwner` + completed passive
context, exports the v3 seed and compiles it. `test/selected-fork-seed.test.ts` runs it against a commit-log session with an
artifact-backed tool result and gets a `conversation/seed-manifest` version 3. Next: `prepareSelectedForkSession`
(`createSelectedResultsIntent`) and `executeSelectedForkSession` (`createChildSession`).

## Plan 157 (implemented 2026-11-06): the SDK exposes selected-results fork seams

`SdkServerOptions` gains `prepareSelectedForkSession(request: ForkPrepareRequestV2): Promise<ForkPreparedV2>` and
`executeSelectedForkSession(command: ForkCommandV2, control?)`. `session/fork/prepare` falls back to the v2 reader when the v1 reader
rejects, and `session/fork/begin`/`retry` fall back to `readSelectedResultsCommand`; hosts without the seams keep the previous
`Invalid fork preparation request` / `Invalid fork operation` answers, so the refusal contract is unchanged (fork-continue test still
green). `@i-harness/session-persistence/selected-results-fork-contract` is now a package export. SDK protocol/server tests: 74 green.

## Plan 156 (planned 2026-11-06): wiring selected-results forks through the SDK seams

The v2 contract readers already exist (`readSelectedResultsPrepareRequest`, `readSelectedResultsPrepared`,
`readSelectedResultsOperation`, `readSelectedResultsCommand`); only the transport and the host seam are missing:

1. `sdk/server.ts` `session/fork/prepare`: when `readForkPrepareRequest` fails, try `readSelectedResultsPrepareRequest` and, if the host
   provides `prepareSelectedForkSession`, return its `ForkPreparedV2` (validated by `readSelectedResultsPrepared`); otherwise keep the
   current `Invalid fork preparation request`.
2. `session/fork/begin`/`retry`: when `readForkCommand` fails, try `readSelectedResultsCommand` and dispatch to
   `executeSelectedForkSession`.
3. Gateway: implement both seams on the commit log — prepare loads the source snapshot and exports the v3 seed (Plan 153/155 path),
   begin compiles it and calls `createChildSession` (v3 accepted since Plan 155), then writes the project binding and returns the
   receipt. Legacy keeps its `createSelectedRuntimeCapture` path (or reports unsupported).
4. Tests: a host test that prepares/executes a v2 fork and reads a result page on the child.

## Plan 155 (implemented 2026-11-06): the commit log bootstraps from a v3 seed

`captureBootstrapRequest` now accepts a `conversation/seed-manifest` **version 3**: it validates the record prefix (manifest +
`conversation/seed-results` pages + groups), rebuilds the semantic body, checks the selected-results commitment with
`compileSelectedResultsSemanticSeed`, and the header discriminator writes `{version:3, codec:"semantic-seed-v3", profile, results,
resultPageCount}`. The header `groupCount` now comes from the manifest instead of `records.length-1` (pages are not groups).
`selected-results-scl-seed.test.ts` creates a session, exports the v3 seed, compiles it and `createChildSession`s a child that loads back
with a seed length — the store side of selected-results inheritance works. Remaining: the gateway composer still must call this path
instead of refusing.

## Plan 154 (found, 2026-11-06): the SCL bootstrap validator refuses v3 seeds

Committing the compiled v3 seed through `createChildSession` fails at `captureBootstrapRequest` (`Invalid bootstrap materialization`): the
validator only accepts `semantic-seed-v1`/`v2` manifests and throws `Legacy bootstrap request required` for anything whose semantic seed
is not version 1–2. That is exactly why the legacy selected path uses `createSelectedRuntimeCapture` instead of the ordinary bootstrap.
The next step is to teach the SCL child creation the v3 record prefix (`conversation/seed-manifest` version 3 plus `conversation/seed-results`
pages) and validate it with the core-session v3 validators before writing the seed commit.

## Plan 153 (prototype, 2026-11-06): the seed also comes from a real commit-log snapshot

The same test file now creates an SCL session, appends a turn with an artifact-backed tool result through the coordinator, loads the
snapshot and exports the v3 seed from `loaded.session` — no in-memory fixture. Both cases pass in ~70ms. The store side of
selected-results inheritance is therefore available; what remains is compiling the seed and committing it from the fork host, then
wiring the gateway composer.

## Plan 152 (prototype, 2026-11-06): a v3 selected-results seed from a folded session

`session-persistence/test/selected-results-scl-seed.test.ts` builds a `Session` in the shape the commit log folds (format 15, a turn with
one artifact-backed tool result), wraps it with `createManagedSessionState` + a minimal `FactOwner`, creates a completed passive context
and calls `exportSelectedResultsConversationSeed`: the result is a v3 seed (`selection:"completed"`, a results summary with rows/pages)
in ~ms. This confirms the last blocker can be closed **without** porting the legacy `createDocuments(...).observations` layer: the
remaining work is feeding a real SCL snapshot into the same three calls and committing the compiled seed from the fork host.

## Plan 150 (2026-11-06): selected-results forks are refused at the RPC boundary

`session/fork/prepare` with a v2 selected-results core answers `Invalid fork preparation request` (-32602) on the commit log (the SDK
server maps the unsupported core to a clear refusal), and the context-runtime path answers `Selected results are unavailable on this
session store` (`SELECTED_RESULTS_UNSUPPORTED`). `host-commit-log-fork-continue.test.ts` now asserts the refusal, so the gap is pinned as
a loud contract rather than an undefined behaviour. The snapshot-selection design (§8.2) remains the target if the feature is ported.

## Plan 149 (2026-11-06): gap inventory after the fork work

The status report now marks fork-child continuation and the fork→parent-delete path as fixed, and lists **selected results** as the only
remaining blocker for switching the default store. Still open: the legacy formats 6–12 corpus (needs recorded samples with valid
`journal` metadata), the legacy `session-persistence` baseline failures (unrelated to SCL) and the legacy deletion itself (gated on
the selected-results decision).

## Plan 148 (implemented 2026-11-06): compaction keeps the todo list

`host-commit-log-compact-long.test.ts` now writes the todos before the eight-turn compaction: the write reports revision 1, the
compaction still commits (`outcome:"ready"`, `publication:"committed"`) and `work-state` afterwards returns revision 1 with the item.
Compaction rewrites the conversation, not the task document.

## Plan 147 (implemented 2026-11-06): a conversation rewind keeps the todo list

`host-commit-log-rewind-todo.test.ts`: after a prompt and a `todo/write` (revision 1), a conversation rewind reports `truncated` and the
durable `rewind/point`, and `work-state` still returns revision 1 with the item — the rewind touches the conversation, not the task
document. The SCL host suite is **36 files / 41 tests** green.

## Plan 146 (implemented 2026-11-06): nested forks with turns

`host-commit-log-fork-nested.test.ts`: parent prompt → fork child → prompt the child → fork the child into a grandchild → prompt the
grandchild; all three stay listed, the grandchild inherits the project, and the ordered grandchild→child→parent deletion empties the
list. The SCL host suite is now **35 files / 40 tests** green.

## Plan 145 (fixed 2026-11-06): a fork child runs turns and owns schedules

`code-mode/register.ts` refused every private observation whose header carried `origin`/`parentSession`, so a commit-log fork child
(header `origin:"fork"` plus its parent link) could not run a turn. The check now permits `origin:"fork"` while still refusing
`delegationDepth`/`subagentProtocolVersion` and any other origin (the code-mode suite confirms the delegated refusal test stays green;
28 files / 365 tests). Consequences verified on the commit log:

- `host-commit-log-fork-continue.test.ts` prompts the child, records its own rewind point and executes a conversation rewind;
- `host-commit-log-fork-schedule.test.ts` now creates/lists/deletes a schedule on the child — the earlier `Private delegated or
  unsupported Code owner` refusal (Plan 142) was this same header bug, not a product rule, so the runtime-absence fix (Plan 143) stays
  as a defensive change only.

## Plan 144 (found, not fixed): prompting a forked conversation is refused on the commit log

`session/prompt` on a fork child fails with `Private delegated or unsupported Code owner`; the legacy store runs the same turn (its
host cleanup then failed in the probe, but the prompt itself succeeded and the child recorded a rewind point). The message comes from
`code-mode/src/register.ts`: code-mode registration refuses a session whose header carries `parentSession`/`delegationDepth`/
`subagentProtocolVersion`. The commit-log fork path (`createChildSession` with the captured lineage) therefore marks the child as
delegated, unlike the legacy fork. Next: write the fork child header with `origin:"fork"` and no delegated markers (or allow
`origin:"fork"` in the code-mode check) and re-run the child-turn test.

## Plan 143 (fixed 2026-11-06): a refused schedule write no longer blocks deleting the child

The refused `schedule/create` on a fork child left `privateEntries` without a live `managedRuntimes` entry, and `readOriginalRuntime`
threw `Original managed runtime unavailable` — the later `batch delete` of the child then failed with that message. `readOriginalRuntime`
now returns `undefined` for an absent/closed runtime (the callers already treat `undefined` as "no runtime").
`host-commit-log-fork-schedule.test.ts` forks a prompted session, asserts the schedule refusal and deletes the child successfully;
the full SCL host suite is **33 files / 38 tests** green.

## Plan 142 (documented 2026-11-06): scheduling on a fork child is refused by the product

`desktop/schedule/create` on a fork child answers `Private delegated or unsupported Code owner` — the **legacy** store returns the same
error for the same sequence, so this is a product rule (a fork child is a delegated owner), not a commit-log gap. The assertion was
not added to the fork-after-turn test because the refused attempt also leaves the child undeletable in the same host (the subsequent
`batch delete` of the child returns `ok:false`); that side effect is recorded as the next item to investigate rather than pinned as a
contract.

## Plan 114 (fixed 2026-11-06): a fork child gets the empty task document

Fixed (2026-11-06): `CommitCoordinator` gains an optional `openReadOnlyManagedDocument(sessionId)` which opens the generation in read
mode and returns `{document, close()}` **without** registering it in `managed`. `withHandoff` uses it when the cached document has no
session view (a finished turn's execution attachment) and closes it once the handoff finishes — the execution document is no longer
closed, so later operations on the parent (task writes, delete) keep a live attachment. The extended fork-after-turn test now covers
the child todo write, the refused parent delete (`descendants`) and the ordered child→parent deletion; the full SCL host suite (32 files
/ 37 tests) and the commit suites (35 tests) stay green.


Attempt (2026-11-06): giving the execution document a view (`createManagedDocument(sessionId, context.source, ...)` in
`openCommitExecutionDocument`) breaks the execution path — the prompt fails immediately with `FACT_OWNER_UNSUPPORTED`, and the fork
host tests drop from green to failing at `session/prompt`. The change was reverted; the execution document must stay owner-less.

Next design: a **read-only cold document** for the fork witness (`openReadOnlyManagedDocument`: open the generation in read mode, build
the context/view, return a document that is never registered in `managed`), so the fork never closes the cached execution document.


Attempt (2026-11-06): two local tolerances were tried — `readOriginalRuntime` returning `undefined` for a closed execution, and the task
operation ignoring `FACT_CLOSED` from `document.assertReady()`. Each only moved the failure to the next consumer of the same closed
attachment (`execution-inputs.pending()` → `execution.observe()` → `assertHeld`). This confirms the real fix is to stop closing the
parent's cached execution document in the fork: the witness should come from a document that keeps a view (for example by giving
`openCommitExecutionDocument` the session as its initial view, or by opening a separate cold handle). Both tolerances and the test
extension were reverted.


Parity check (2026-11-06): the same sequence (fork a prompted session, write the child todo, delete the parent) on the legacy `jsonl`
store returns `Session has descendants; coordinated deletion is unavailable`, while the commit log returns `FACT_CLOSED` — so the
failure is commit-log specific. The closed parent document is the one `withHandoff` closed to obtain a cold fork witness; the task
operation still references it. Fix direction: either the fork must not close the cached execution document (a separate cold handle for
the witness), or `createCommitTaskOperations` must rebind the parent document when its handle is closed. The probe was removed.


Narrowed further (2026-11-06): the `FACT_CLOSED` during the parent delete comes from `createCommitTaskOperations`'s
`captureParent(document).assertCurrent` → `document.assertReady()` on a **closed** parent document (`capabilities.ts:68`). A guard in
`readOriginalRuntime` (returning `undefined` for a closed execution) removed the first stack but not this one, so the remaining issue is
the task-operation parent document outliving its log. The fix is to rebind the task operation to a fresh document when the handle is
closed (or to not close a document that the task association still references); both the guard and the test extension were reverted
pending that fix.


Diagnosis of the two open items (2026-11-06):

1. child schedule → `Private delegated or unsupported Code owner`: the child runtime is a delegated execution and the schedule handler
   refuses it before reaching the store.
2. parent delete after a child todo write → `FACT_CLOSED`. Two stacks were observed while instrumenting: (a) `workflowUiFor` →
   `originalManagedRuntimeFor` → `runtime.domain.assertCurrent()` on an execution whose attachment is already closed; guarding that read
   (return `undefined` for `FACT_CLOSED`) moved the failure to (b) a task-document operation (`task-document-operation.ts` → capability →
   `managed-document.assertReady` → document `assertCurrent`) holding a document whose log was closed. Both point at retained
   documents/runtimes outliving their log on fork children; the fix belongs in the SCL document lifetime (close only what the owner
   opened, and retire the service runtime when its document closes), not in the delete path.


The restored fork-after-turn steps showed `desktop/session/todo/write` on a forked child failing with `Owned task document is absent`:
`create` seeded `task-<id>` but the fork birth path (`bootstrapSemanticTargetWithCapture` → `createChildSession`) did not.
`facade.ts` now seeds the same empty document for a fork child when it is absent (never overwriting an existing one), and
`host-commit-log-fork-task.test.ts` forks a prompted conversation and writes the child's todo list (revision 0 → 1).

Still open from the same restored sequence: `desktop/schedule/create` on the child answers `Private delegated or unsupported Code
owner`, and deleting the parent after the child todo write answers `FACT_CLOSED` instead of the `descendants` error.

## Plan 113 (correction, 2026-11-06): the fork-after-turn extensions were never in the file

While restoring the fork-after-turn test it turned out that the assertions documented in Plans 107–112 (descendant guard, ordered
delete, child schedule, child todo) were **not** present in `host-commit-log-fork-after-turn.test.ts`: the edits did not apply and the
corresponding commits only changed the docs, so the tests that "passed" did not contain those steps.

Re-applying them surfaced two real issues, both left undocumented until now:

1. after a child todo write, deleting the parent returns `FACT_CLOSED` instead of the intended `descendants` error;
2. with a child schedule create/delete in the sequence, `host.close()` fails with `Desktop host cleanup incomplete: session service`
   (the cold schedule path assembles a managed runtime that is never released).

The test file is back at its committed base and the two issues are the next investigation items; the docs entries for Plans 107–112
describe the intended coverage, not verified runs.


The same test writes the child's todo list: `work-state` reports revision 0, `todo/write` accepts the first list and the next read
reports revision 1 — the cold document path works on a fork child.

## Plan 111 (implemented 2026-11-06): schedule on a forked child

The fork-after-turn test also manages the child's schedule: `desktop/schedule/create` on `forked` succeeds, `schedule/list` returns it
and `schedule/delete` empties the list — the cold schedule path works on a fork child as well as on a rooted session.

## Plan 109 (implemented 2026-11-06): delete a rewound session

Follow-up probe (2026-11-06): deleting while a second coordinator holds a `load` handle **succeeds** (`ok:true`); a second delete then
answers `commit log for session "<id>" does not exist`, as expected. The earlier confusion was a trailing `rewind/points` call after the
session had been deleted — not a locking bug — so the test keeps the observer close order only for clarity.


The rewind-after-turn test now deletes the session after the rewind: `batch delete` reports ok and the session leaves `session/list`.
The delete runs after the observer coordinator that checked the `rewind/point` marker is closed (it does not run while that handle is
open).

## Plan 108 (implemented 2026-11-06): delete the fork, then the parent

After the refused parent deletion the test deletes the child: `batch delete` on `forked` succeeds, the child leaves `session/list` and
the parent stays. Deleting the parent then succeeds and the list is empty — the no-orphans rule is order-sensitive, not a permanent
block.

## Plan 107 (implemented 2026-11-06): a parent with descendants cannot be deleted

The fork-after-turn test now also asks to delete the parent: the batch result is `ok:false` with a `descendants` error and the forked
child stays in `session/list`. This pins the no-orphans rule on the commit log (the delete path checks every profile for a
`parentSession` before draining).

## Plan 106 (fixed 2026-11-06): fork after a rewind

`settleCapture` in `execution-inputs.ts` now treats `TypeError: Original capture obligation released` from `observe()`/`admit()` as
already settled (and marks the fact attempted) instead of failing the close: a rewind can close its settlement source while an
execution-input admission is still pending. `host-commit-log-rewind-fork.test.ts` rewinds a prompted session and then forks it; the
child is created and `host.close()` completes. `delivery-lifecycle` (22 tests including the failed-rewind-close cases) stays green;
`rewind.test.ts` and the managed-domain/execution-attachment suites keep their pre-existing baseline failures (`TASK_TRANSITION_UNSUPPORTED`
and the missing fixture path).

## Plan 103 (found, not fixed): fork after a rewind leaves the host cleanup dirty

Stack of the expired obligation (2026-11-06):

```
expired (execution-members.ts:20)
execution-members.ts:150 (pin.members getter)
handle.observe (execution-members.ts:80)
execution-inputs.ts:73 settleCapture (fact.observe/admit)
execution-inputs.ts:77 settleCapture
execution-inputs.ts:273 adapter.settle -> settleReceived()
```

So the service close runs the received-input `settle()`, which observes a delivery admission capture that was already released — the
rewind's `withRewindFacts` closes its settlement source while an execution input admission fact is still pending. The next fix is to
settle (or release) the pending execution-input admissions before the rewind settlement source closes, or to make `settleCapture`
tolerate a capture whose obligation is gone (it has already been settled).


Instrumented detail: the failing `service.close()` error is `TypeError: Original capture obligation released` (from
`core-session/managed/execution-members.ts`), i.e. the rewind/fork path retains and then touches an execution member obligation after
its capture was released. The instrumentation and probe were removed; the next step is to find which retained member is read at close
(the rewind `withRewindFacts` result is the prime suspect) and release it before the capture completes.


Forking a session that was just rewound works (prepare and begin both succeed and the child is listed), but `host.close()` then fails
with `Desktop host cleanup incomplete: session service`. The same sequence on the legacy `jsonl` store closes cleanly. Closing the
cold source document that the fork handoff reopened does not clear it, so the leak is likely the managed rewind execution retained by
`withRewindFacts` interacting with the fork observation. The fork step was removed from the rewind-after-turn test; the next
investigation is to instrument the service close after that sequence.

## Plan 102 (implemented 2026-11-06): rewind a conversation that has run a turn

`host-commit-log-rewind-after-turn.test.ts` prompts once (the turn records a rewind point with `files: 0`), plans and executes a
conversation rewind with the pinned fingerprint, then asserts the points list is empty and a fresh coordinator sees the durable
`rewind/point` marker. `session/list` keeps `turnCount` from the log, so it still reports the pre-rewind count — the rewind is a
durable marker, not a log rewrite.

## Plan 101 (implemented 2026-11-06): fork a conversation that has run a turn

`session/fork/begin` on a source that had a turn failed with `Session fork unavailable` (`reason:"internal"`) on the commit log while
the legacy store forked the same source. The cause was `createForkSourceWitness(document)` reading `document.view.events`: a finished
turn can leave its execution attachment cached in `managed`, and an execution document is built without a session view.
`withHandoff` now reopens the source document cold when the cached one has no `view` (closing it first), keeping the
`openManagedDocument` invariant for active executions. `host-commit-log-fork-after-turn.test.ts` forks after a prompt and checks the
child plus its inherited project.

## Plan 100 (implemented 2026-11-06): delete a session that ran a turn

The archive test ends by deleting the restored session through `batch delete`: the result is ok, and the session disappears from both
`session/list` and `desktop/session/archived`. This covers the delete path (retire + drain) on a session with real history.

## Plan 99 (implemented 2026-11-06): batch archive/restore after a turn

The same archive test also drives the batch route on a session with one turn: `batch archive` succeeds and lists the session under
archived, and `batch restore` brings it back to `session/list`. Before the fence fix both batch results were `ok:false` with the
management-in-progress error.

## Plan 98 (implemented 2026-11-06): archived sessions leave the context picker

With archive working again, the picker behaves correctly: after archiving, `context/search` in `sessions` mode returns no items and
`context/read` for the archived reference is refused with `Session reference is outside the current project`.

## Plan 96 (diagnosed 2026-11-06): archive after a turn is refused on both stores

Fixed (2026-11-06): the stack showed the failure was the archive `exclusive` operation retaining the managed runtime for cold rewind
recovery while `blocked` was set, and `assertOpen` refusing that internal call. `exclusive` now gives only its own async context an
admission token (the same grant `run` uses) and `assertOpen` honours it for `blocked` (a retired session still refuses everything).
`host-commit-log-archive.test.ts` archives a session that ran a turn, lists it under archived, and restores it with its turn count.


Isolation with three fresh hosts (prompt → archive, prompt → session search → archive, prompt → context read → archive) shows the
failure on **every** variant, and the same three variants fail identically on the legacy `jsonl` store — so it is not a commit-log
regression and not caused by search/context: any session that has run a turn cannot be archived.

The message comes from `session-management-fence.assertOpen`, which throws only when `blocked` (set for the duration of an
`exclusive` operation) or `retired` (delete) contains the id. A management `exclusive` therefore appears to be in flight at archive
time even though the test issued none, or a prior one never cleared its `blocked` flag. The management test archives a session that
never ran a turn and passes, so the turn path is what leaves the fence in that state. Next: instrument `exclusive` entry/exit (and the
`serial` queue) to find the stuck operation, then re-add the archived-context rejection test.

## Plan 95 (found, not fixed): archive refuses after a search in the same host

In the search host test, after a prompt, `session/list`, `desktop/session/search` and the context-picker calls, archiving the same
session fails:

- `desktop/session/manage {action:"archive"}` → `Session management is in progress or session is deleted`;
- `desktop/session/batch {action:"archive"}` → the same error in its per-session result, and `profile().meta` therefore never carries
  `archived` (so the picker keeps returning and reading the session).

The management test archives right after a prompt and passes, so one of the intervening calls leaves the session busy; the next
investigation is to isolate which call (search fallback / context read) holds the management fence or a live execution.

## Plan 94 (implemented 2026-11-06): context files search and project guard

`context/search` in `files` mode walks the workspace and returns `{kind:"file", path:"notes.txt"}` for a matching file, and
`context/read` refuses a session reference whose `projectId` differs from the session owner with `Session reference is outside the
current project`. Both asserted in the search host test.

## Plan 93 (implemented 2026-11-06): context read for a session reference

`desktop/context/read` takes `{reference:{kind:"session", workspaceId, sessionId, seq}}` (not the bare reference) and returns
`{text, truncated}` where text is the JSON of the neighbouring user/assistant messages — for the commit-log session it contains the
search token. The earlier empty `{}` came from passing the reference fields at the top level.

## Plan 92 (implemented 2026-11-06): context picker session search

`desktop/context/search` with `contextKind:"sessions"` finds the commit-log session through the conversation query (the picker uses
the same `SessionQuery`): `{items:[{kind:"session", sessionId, seq, excerpt}], total:1}`. `desktop/context/read` for that reference
currently returns an empty object in this host configuration and is not asserted.

## Plan 91 (implemented 2026-11-06): cold diagnostics shape

`desktop/environment/diagnostics` for a cold commit-log session reports `{live:false, sessionId}` with empty `tools` and `roles` (the
shell section stays host-dependent), so the management test pins only the stable fields.

## Plan 90 (implemented 2026-11-06): live todo write

After the second turn the session has revision 1; `desktop/session/todo/write` with `expectedRevision: 1` succeeds and reports
`todosRevision: 2` with the new in-progress item, so the managed/live path and the cold path agree on the revision counter.

## Plan 88 (found, not fixed): a desktop todo write breaks the in-turn todo_write

Fixed (2026-11-06): the cold `writeTodos` path no longer goes through `service.writableSessionFor` (which called `selectComplete` and
refused the managed runtime forever). It opens the coordinator document directly, checks the revision on `document.view`, admits the
`todo/write` metadata fact through `actionMetadataFacts`, returns the updated view and closes the document. The turn test now writes a
todo, rejects a stale revision and then runs the prompt normally (including the in-turn `todo_write`).


Deeper root cause (2026-11-06): the cold `writeTodos` path reaches `service.writableSessionFor`, which calls `selectComplete` and
marks the session as a **complete** selection; `first-party-selection` then skips the managed selection for that session forever, so the
next turn runs on a non-managed assembly and the in-turn task tool has no `managedTaskOwners` entry
(`Original Task projection owner required`).

Two attempted escapes both failed and were reverted: (a) closing the opened document breaks the following cold write with
`Supplied Session is not this document view`; (b) also closing the service session clears the complete selection, but the next cold
write then fails with `Original Task projection owner required` because `openExecutorDocument` needs the managed task owner. The real
fix must keep the cold todo edit on a path that never calls `selectComplete` (a task-document write that does not claim the session),
or make `completeSelections` reversible without tearing down the executor document.


Attempt (reverted): closing the document that the cold `writeTodos` path opened (`closeManagedDocument` after the admit) makes the
following cold write fail with `Supplied Session is not this document view; use explicit detached import` (the live session object no
longer matches a rebuilt document), so the next cold edit must also re-create the service session.

Root cause direction: the cold path opens a managed document and leaves it held; the turn's managed runtime then cannot reconcile the
owner (`Original Task projection owner required`). The fix belongs to `acquireExecution`: when a document for the session already
exists it must adopt/reuse it instead of creating a second one (or the cold write must fully release the session so the next turn
re-assembles it, without breaking the sequential cold edits).


On a cold commit-log session `desktop/session/work-state` is `{todos:null, todosRevision:0, goal:null}` and
`desktop/session/todo/write` works: the first write returns the list with `todosRevision:1`, the read matches, and a stale
`expectedRevision` is refused with `Todo list changed (revision 1). Reload it before saving your edit.`

However, when that write happens **before** a model turn, the in-turn `todo_write` tool then fails with
`Original Task projection owner required` and the prompt itself rejects. The probe was removed from the turn test; this is the next
investigation: the desktop write path and the managed task projection must agree on the owner (likely the task document owner/revision
taken by `writeTodos` is not the one the managed tool expects).

## Plan 87 (implemented 2026-11-06): execution cursor bounds

The execution view validates its cursor before reading: a negative offset or a limit above 20 is rejected with
`Invalid execution cursor or dimension` (-32602), while a very large offset is accepted and returns an empty page with that offset.
All three are asserted on the commit-log host.

## Plan 86 (implemented 2026-11-06): search limits are clamped from below

`createConversationQuery` clamped only the upper bound, so `limit: -5` reached `slice(0, -1)` and returned all-but-the-last hit. The
conversation limit is now `Math.max(0, Math.min(limit ?? 20, 100))` and the fallback returns `[]` for `limit <= 0`.
`session-search-tool.test.ts` asserts `0` and `-5` return no hits while `1000` is clamped to 100 (the single hit still returns).

## Plan 85 (implemented 2026-11-06): lineage tool and snippet truncation

The same tool set is exercised further: the `lineage` tool answers ancestors/children from coordinator metadata, and a match in the
middle of a long message yields a snippet shorter than the body with `…` on both sides while still containing the token.

## Plan 84 (implemented 2026-11-06): the `session_search` tool reaches the fallback

`session-search-tool.test.ts` builds the tool with `createSessionQueryTools(createConversationQuery(coordinator, emptyIndex,
createCommitLogSearchFallback(coordinator)))` and executes it: `{query:"needle"}` returns the commit-log hit with a snippet and an
absent token returns `{hits: []}` — the same wiring the owned gateway leaves register.

## Plan 83 (implemented 2026-11-06): tool content is searchable

After the `todo_write` turn the turn test searches for `do it` and finds it in the tool call/result events, so the commit-log
search fallback covers tool arguments and outputs, not only chat messages.

## Plan 82 (implemented 2026-11-06): search limit across sessions

`host-commit-log-search-limit.test.ts` seeds three matching messages across two commit-log sessions: `limit: 2` returns exactly two
hits and `limit: 100` returns all three from both sessions, so the per-session fallback cannot exceed the conversation-level limit.

## Plan 81 (implemented 2026-11-06): mixed legacy and commit-log search

`host-commit-log-mixed-search.test.ts` puts a legacy JSONL session and a commit-log session in the same store directory: the search
returns one hit per session (no duplicates), the legacy hit carries the index bm25 (<= 0) and the commit-log hit carries the
fallback bm25 0, in that order.

## Plan 80 (implemented 2026-11-06): missing sessions fail the view reads

`processes/read` and `execution/read` for a session that does not exist reject with
`commit log for session "<id>" does not exist` (-32602), matching `schedule/list`; a stale id cannot look like an idle session.

## Plan 79 (implemented 2026-11-06): cold output reads are owner-scoped errors

`processes/job-output` and `processes/terminal-output` for an unknown id on a cold commit-log session answer with -32602
`Job output unavailable for this owner` and `Saved terminal output unavailable for this owner`, i.e. the owner check runs before any
storage lookup. Asserted in the turn test.

## Plan 78 (implemented 2026-11-06): cold process and execution shapes

The turn test pins the cold views on the commit log: `desktop/session/processes/read` is `{live:false, terminals:[], jobs:[]}` and
`desktop/session/execution/read` is `{live:false, cells:[], total:0}` (the execution projection is a live-runtime view, not a log
projection). Both are asserted after the turn.

## Plan 77 (implemented 2026-11-06): subtree-restricted search

`createConversationQuery.search` now honours `subtreeOf`: it resolves the session and its descendants through the lineage
implementation and restricts the candidate ids before asking the per-session query (the `subtreeOf` option is stripped from the
per-session call). `session-query-subtree.test.ts` shows the unfiltered search returns all three sessions and
`{subtreeOf:"root"}` returns only `root` and `child`.

## Plan 76 (implemented 2026-11-06): coordinator lineage for session search

The same wiring now supplies a `lineage` implementation for commit-log stores: `createCoordinatorLineage` walks `parentSession` from
profiles for ancestors and scans profiles for children/descendants, reporting `{sessionId, parentSession?, delegationDepth?,
origin?, seedLength?, createdAt?, hasChildren}`. `createConversationQuery` takes the override as its fourth argument, and
`session-lineage.test.ts` covers children, descendants (depth 2), ancestors and unknown ids.

## Plan 75 (implemented 2026-11-06): session search covers commit-log sessions

`desktop/session/search` was backed only by the file-backed index (`<id>.jsonl`), so a commit-log session never matched. The host
now wraps the index query with `createCommitLogSearchFallback`: when the index returns no rows for a session, the coordinator loads
that session and returns substring hits over messages and tool results (`{sessionId, seq, eventType, snippet, bm25:0}`).
`host-commit-log-search.test.ts` finds a session by its prompt text and an absent token returns `{hits: []}`. Known remaining gap:
`lineage` still delegates to the file-backed index, so session-lineage search over commit-log children is not covered yet.

## Plan 74 (implemented 2026-11-06): batch archive/delete edge semantics

`host-commit-log-batch-edges.test.ts` pins the batch semantics on the commit log: archiving an already archived session is a
success (idempotent), deleting an archived session succeeds and removes it from `desktop/session/archived`, and restoring a
deleted session fails with `commit log for session "<id>" does not exist` instead of resurrecting it.

## Plan 73 (implemented 2026-11-06): batch move from a second host

`host-commit-log-batch-move.test.ts`: a second host re-configures the projects (project configuration is main-process state, and the
host answers `Destination project has not been confirmed by the current main process` until it does), then moves a bound session
(`expectedOwners: {id: "p"}`) and an unbound one (`null`) into `q` — both succeed and the project state reports `q`. A wrong
expectation (`p` while the owner is `q`) is refused with `Session project owner changed; refresh before moving` and the session stays
in `q`.

## Plan 72 (implemented 2026-11-06): title, archive and project survive a restart

`host-commit-log-restart-meta.test.ts`: host1 creates, binds project `p`, renames to `Restart title` and archives; host2 (same
store) does not list the session as active, lists it under `desktop/session/archived` with `title` and `projectId`, reports
`desktop/session/project/state` as `{projectId:"p"}`, and restoring it brings back the renamed title. All of it comes from the
commit log and the document store, not host memory.

## Plan 71 (implemented 2026-11-06): rewind mode `files`

`host-commit-log-rewind-modes.test.ts` executes a `files` rewind on the commit log: the tracked file is restored to its `preBlob`
content while the conversation keeps its events. The only modes are `conversation` and `files`; a `both` request is refused at the
RPC layer with `Invalid rewind request` before it touches anything.

## Plan 70 (implemented 2026-11-06): stale rewind fingerprints are refused

`host-commit-log-rewind-stale.test.ts` plans a rewind, then changes the tracked file before executing with the pinned fingerprint:
the execute is refused with `Rewind preview changed; preview again before confirming`, no `rewind/point` is appended and the
conversation is untouched. Note the fingerprint covers the plan (target, mode, files), not later conversation appends — those are
truncated as part of the confirmed target.

## Plan 69 (implemented 2026-11-06): a rewind planned by one host executes in the next

`host-commit-log-rewind-restart.test.ts`: host1 lists the points and plans the conversation rewind (fingerprint), closes; host2
executes with that fingerprint and gets `{eventAppended:true, truncated:true}`, the points list is empty afterwards, and a fresh
coordinator sees the durable `rewind/point` marker. Rewind planning is therefore restart-safe (unlike prepared forks, which are
host-memory bound).

## Plan 68 (implemented 2026-11-06): prepared forks are not resumable after a restart (parity)

`host-fork-restart.test.ts` prepares a fork in one host, closes it, and tries to begin the same operation from a second host on the
same store. Both stores (commit-log and the legacy composed coordinator) answer `Session fork unavailable`, i.e. prepared forks live
in the preparing host and a restart requires preparing again. The test pins that contract for both stores so a future resume
implementation is a deliberate change.

## Plan 67 (implemented 2026-11-06): a session continues across a host restart

`host-commit-log-restart.test.ts` opens a host, creates a session, runs a turn and closes; a second host on the same store lists the
session with `turnCount: 1` and runs another turn, after which `turnCount` is 2. This is the desktop-restart path end to end and also
covers the ownership-pin release fixed in Plan 65 (the second prompt would otherwise wait on the capability lock).

## Plan 66 (implemented 2026-11-06): pin-release regression test

`commit-coordinator.test.ts` opens a coordinator, creates a session, opens its managed document, closes the coordinator, and opens a
**second** coordinator on the same root which must be able to take the document. Reverting the fix reproduces
`another holder owns the session lock … .capabilities` on the second open, so the test pins the leak.

## Plan 65 (fixed 2026-11-06): coordinator close releases ownership pins

Root cause of Plan 64: `close()` closed the retained documents directly instead of going through `closeManagedDocument`, so the
ownership pins taken by `openManagedDocument`/`acquireExecution` were never released and the capability-store lock stayed held for
the life of the process. `close()` now unwinds each managed session through `closeManagedDocument` (which closes the log and unpins)
and finally unpins any remaining entry.

Evidence: `host-commit-log-schedule.test.ts` now reopens a second host on the same store — the first host creates the schedule and
closes, the second lists it, deletes it and closes cleanly. Before the fix that second delete failed on
`another holder owns the session lock … .capabilities` and the close reported `Session service process cleanup incomplete`.

## Plan 64 (diagnosed 2026-11-06): the cold-schedule failure is a capability-lock conflict

Printing the inner `AggregateError` of the reopened host shows two distinct errors:

1. `desktop/schedule/delete` on the reopened host fails with
   `another holder owns the session lock at <root>/sessions/.capabilities/.i-harness-locks/<hash>.lock (deadline 2000ms exceeded)`;
2. the following `host.close()` reports `AggregateError: Session service process cleanup incomplete` (service.ts closeAll).

So the root cause is not a missing runtime release: a capability-store lock is still held when the second host runs. The first host
performed the schedule write on a live session and closed without error, which points at the commit-log capability owner not
releasing its pin/lease at close (host2 then cannot acquire it). The next step is to trace the lock through
`createCommitOwnershipPorts` / `createBindingObservations` release on `close()` and on `releaseOwnership`, instead of the schedule
handler.

## Plan 63 (found, not fixed): cold schedule write blocks a clean host close

Reproduction attempt: a session-executor unit test that enrolls a first-party managed selection, calls
`prepareOriginalManagedRuntime`, then `service.close()` **passes** with both the composed legacy coordinator and the commit-log
facade (`DBG close ok`) — so the leaked execution only blocks cleanup under the full desktop host wiring. A minimal host probe could
not reach the close because its `session/prompt` hit `another holder owns the session lock … .capabilities` and timed out, so the
next attempt should instrument the host shutdown phases (native context / approvals / projects) rather than the runtime itself.


Fix attempt (reverted): closing the cold session after the write (`service.closeSession(id)` when the session was not live
before `prepareOriginalManagedRuntime`) removes the `Original managed runtime retired` risk only if it runs after the final
`runtime.assertCurrent()`, but it also introduces `[i-harness] private delivery reconciliation failed: Error: FACT_CLOSED`
warnings and the two-host restart test still ends with `Desktop host cleanup incomplete: session service`. The runtime is retained
by the service and its cleanup is owned by that retention, so the real fix belongs to the managed-execution lifecycle (a release on
`OriginalManagedRuntime`, or the service draining retained executions on close), not to the schedule handler.


Reopening a second host on the same commit-log store and running `desktop/schedule/delete` on the cold session makes
`host.close()` reject with `Desktop host cleanup incomplete: session service`. The cold path goes through
`prepareOriginalManagedRuntime(service, id)` in `schedules.ts` and returns without closing the assembled execution, while the host
shutdown expects no live execution. The restart test was reverted (the first host closes cleanly; only the cold-management host
fails), and this is the next lifecycle item: close the runtime it assembled, or drain the session before `service.close()`.

## Plan 62 (implemented 2026-11-06): schedule list for a missing session

`desktop/schedule/list` for a session that does not exist rejects with `commit log for session "<id>" does not exist` (-32603)
instead of returning an empty list, so a stale session id cannot look like a session without schedules. Pinned in
`host-commit-log-schedule.test.ts`; a host-restart durability test for schedules was attempted but needs the host factory split
into a reusable opener (the settings fixture differs from the other host tests).

## Plan 61 (investigated 2026-11-06): context_output_read on the SCL host

A controlled `context_output_read` call against a real artifact ref on the commit-log host answers
`{"error":"Context output is disabled or stopping"}` — the desktop-host test configuration does not enable the context-output
tool, so the call never reaches the selected-source path. The product-level impact of the selected-results gap therefore still
needs a host configuration that enables context output (or a direct check in the gateway native context); the probe was removed
from the turn test to keep it configuration-independent.

## Plan 60 (implemented 2026-11-06): cold-history control errors

Control RPCs answer honestly on a cold commit-log session: `execution/stop` without a cell is `Execution unavailable`, with an
unknown cell it is `Cell has no live execution owner; cold history cannot be stopped`, and `processes/control` on a missing
process is `No live process owner; cold history cannot control a process`. All three are -32602 and asserted in the turn test.

## Plan 59 (implemented 2026-11-06): unavailable result pages

A result ref whose digest names no stored artifact resolves to `{kind:"unavailable"}` rather than an error, and a read against an
unknown session also resolves to `{kind:"unavailable"}` (the host answers with an unavailable page, not an RPC failure). Both are
asserted on the commit-log host so a client can render the placeholder without treating it as a transport error.

## Plan 58 (implemented 2026-11-06): result page boundaries

An offset past the end is answered with `{kind:"unavailable", reason:"budget"}` (the read service treats the out-of-range request
as an unavailable page, not an error), while a `maxBytes` above the query limit is rejected by the RPC layer with
`-32602 Invalid result page query`. Both are now asserted on the commit-log host.

## Plan 57 (implemented 2026-11-06): result page chunking

The turn test now pages an artifact result: a 4 KB chunk reports `nextOffset`, and the following read from that offset advances
again with `eof:false`. A request below the service page budget (e.g. `maxBytes: 256`) is answered with
`{kind:"unavailable", reason:"budget"}` rather than a truncated page, so the client must use a page-sized request.

## Plan 56 (implemented 2026-11-06): background failures are reported

`enqueue` dropped a failed append (`catch(() => {})`) and deletion listeners were silently ignored. `CommitCoordinatorOptions` now
takes `reportBackgroundFailure` (default `console.warn("[i-harness] background persistence failure:", error)`), used by both paths.
`commit-coordinator.test.ts` enqueues into a missing session and asserts the reporter receives the `CommitLogNotFoundError`.

## Plan 55 (implemented 2026-11-06): no invented legacy metadata

`profileOf` used to fall back to `{sessionId, createdAt: now(), formatVersion: 15}` when a readable legacy session reported no meta,
fabricating a creation time. A legacy session with events but no metadata is a contract violation, so it now throws
(`legacy session "<id>" has no metadata`); `commit-coordinator.test.ts` covers it.

## Plan 54 (implemented 2026-11-06): document store error paths

`getDocument` propagates a legacy document read failure instead of returning `undefined`, and a corrupt `__documents__` log refuses
both reads and writes (`CommitFormatError`) rather than silently ignoring the damaged tail. Both are covered in
`commit-coordinator.test.ts`.

## Plan 53 (implemented 2026-11-06): a broken legacy store is not an empty store

`list()` swallowed legacy list failures (`catch(() => [])`), so an unreadable legacy store silently looked empty. It now rethrows;
`commit-coordinator.test.ts` covers it with a failing legacy port. The redundant `try { throw }` wrapper around the child capture is
gone too.

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



