# Additional B1 public-writer controls — 2026-10-23

Root requested B3/B4 after the original A–E execution receipt, before any fix dispatch. This separate receipt preserves the previous report and all existing evidence. These are actual offline API observations on unchanged product; no implementation or general backend redesign was attempted.

## Identity, command and evidence

- HEAD before/after: `bf4c0aa5b24f3755d8d0e685fd161b57e6133a27`; CWD `D:/I-harness-main`; git status empty.
- Fresh sibling scratch root, refused if already present: `D:/I-harness-main/.tmp/r4b-b1-public-writers-probes-20261023`.
- Exact runtime command: `pnpm exec tsx .tmp/r4b-b1-public-writers-probes-20261023/probes.ts`.
- Actual exit: **0**. `01-command.json` saves the command/exit; `01-probes.log` retains complete output/stacks; `results.json` retains full outcomes, header values, byte counts and SHA256 digests.
- **Zero runtime setup failures.** All four separate targets passed real `backend.read` and `projectConversation` before the attempted mutation. Plain target: version11/0events/0items. Each ready target: version11/3events/2items.
- Ready setup uses genuine `createJsonlBackend(store).create` with supported metadata and literalReady reservation, then supported `replaceEvents` with all three literalReady records. No incomplete prefix is treated as successful setup.
- SHA256 before/after checked the same **131** tracked product/fixture files as the original receipt: all source under core-session/session-persistence/session-persistence-jsonl plus `format11-seed.ts`; **0 changed**. Receipts: `source-before.json`, `source-after.json`, `source-comparison.json`.
- Previous `task-1-probes-20261023.md` SHA256 remains **`ddcb8eb4673250640c3c207b10489201ae78faa4ca9830d98534e20a47618a57`**, confirming that report was preserved.
- Sole product runtime owner; runs were sequential. No fix, maintained-test/product edit, commit, live provider/account/user session, subprocess suite, or old evidence write.

## B3 actual `backend.replaceEvents`

| Control | Mutation | Returned outcome | Bytes before → after | Subsequent public read |
| --- | --- | --- | ---: | --- |
| `B3-plain-orphan` | Valid plain current11 target; `replaceEvents(id,[literalReady.events[0]])` | **Resolved undefined** | **277 → 1087**, changed | **Rejected `TypeError: Invalid semantic seed`** |
| `B3-ready-no-completion` | Valid ready current11 target; `replaceEvents(id,literalReady.events.slice(0,-1))` | **Resolved undefined** | **2898 → 2633**, changed | **Rejected `Error: bootstrap-incomplete`, code `SESSION_BOOTSTRAP_INCOMPLETE`** |

Both retain the same header values (`changedHeaderKeys:[]`). The first writes a literal seq0 manifest without a reservation; the second removes only the final completion record from an actually readable ready target. Each later read leaves the written bytes unchanged. Raw before/after artifacts remain as `<case>-before.jsonl` and `<case>-after.jsonl`, alongside the stores.

Current code path: `packages/session-persistence-jsonl/src/index.ts:203–215` reads the existing header; at210 it invokes complete history validation only when incoming events contain `compaction/replacement`. Neither requested seed control does. It encodes the supplied events at213 and publishes via `replaceRawSessionFile` at214. The later real public read at147 reaches `core-session/src/serialization/fact-journal.ts:88`'s history validation and then bootstrap readiness: no-header refusal at `conversation/bootstrap-validation.ts:53`, missing completion refusal at82. These observations concern readiness before public replacement publication; they do not propose widening or changing unrelated backend behavior.

## B4 actual `backend.updateMeta`

The changed reservation remains independently **valid shaped**: before the update, the script calls the actual `validateSeedHeader` against the patch. It clones the real loaded reservation and changes only the first valid hexadecimal digit of `seedDigest`, from9 to0:

```text
before: 9d5c8883be3c13c41720b5eb99708e626515685554288c65cd6b8150ac363372
after:  0d5c8883be3c13c41720b5eb99708e626515685554288c65cd6b8150ac363372
```

The patch is exactly `{semanticSeed: changedReservation}`; other reservation fields and ordinary metadata remain unchanged.

| Control | Mutation | Returned outcome | Bytes before → after | Subsequent read/projection |
| --- | --- | --- | ---: | --- |
| `B4-ready-seed-digest` | Valid ready target; one valid hex digit changed in semanticSeed.seedDigest | **Resolved**, returns changed reservation | **2898 → 2898**, content changed | **Rejected `TypeError: Invalid semantic seed`** |
| `B4-title-positive` | Separate valid ready target; `{title:'changed title'}` | **Resolved**, returns new title | **2898 → 2897**, content changed | **Resolved**, version11/**3events/2items**, title `changed title` |

For the digest mutation, `semanticSeed` is the only changed top-level header key and `seedDigest` is the only changed nested reservation value. The title remains `original title`. For the title control, only `title` changes and the reservation remains intact. Both updates preserve event-body bytes exactly, independently checked by SHA256:

| Case | Body SHA256 before and after |
| --- | --- |
| Digest mutation | `4975571c65ac2d06840c5a69e6610ff4ceb4ed9397fb17861ee91c1a9c827542` |
| Title positive | `545e1f2619663391cab8fea32968d7d4a242b2c6501e5a8672cf6c2683f0d74d` |

Thus body-preserving metadata mutation works for an ordinary title but can also change the protected seed identity and invalidate the same otherwise complete stored history. Current `packages/session-persistence-jsonl/src/index.ts:245–267` protects journal changes at258 and format changes at259, then merges the patch at260, serializes the merged header at262 and atomically renames it. It does not reject a changed semantic reservation or validate the resulting reservation against preserved records before publication. Subsequent read reaches `bootstrap-validation.ts:63`, which detects manifest digest/header seedDigest mismatch. Read changes no bytes in either case.

## Result and scope

The additional controls confirm that the readiness publication gap observed through public append is also reachable through these two public writer surfaces: seed `replaceEvents` and semantic reservation `updateMeta`. The title positive control preserves the distinction between an ordinary metadata-only edit and a change to fixed seed identity. No broad public-backend rewrite is inferred or performed here. Root owns the consolidated finding and correction scope.

Runtime is finished; all processes have exited. Previous report/evidence remain unchanged, product hashes remain unchanged, and the original staged fork baseline remains RED pending B2.
