# rc4 Desktop: a forked session cannot continue on the legacy store

Status: **fixed 2026-11-07** (rc4+, legacy JSONL store).

## Reproduction

1. rc4 Desktop, legacy store (`sessionStore` unset/jsonl), a project session with one completed turn.
2. Fork it through the Desktop bridge (the UI's "建立分支" uses the same RPCs):

    desktop/session/fork/prepare { request: { version: 1, sourceSessionId } }
    -> prepared { core: { selection: { kind: 'completed' } }, requestDigest }
    desktop/session/fork/begin { operation: { prepared, invocation: { targetSessionId: 'forked-session-1' } } }
    -> ready; session/list shows forked-session-1

3. The fork's history is a v1 semantic seed that **contains the source turn**:

    conversation/seed-manifest (codec semantic-seed-v1, turns.completed [[1,1]], origins source)
    conversation/seed-group (messages [{ role: 'user', content: '只回覆 hi。' }])
    conversation/seed-group
    session/bootstrap

4. Sending any prompt into the fork fails:

    session/prompt               -> RpcError: Original execution attachment requires its original entry construction
    desktop/session/input/submit -> same

## Root cause (located 2026-11-07)

`packages/session-persistence/src/coordinator/managed-documents.ts` `acquireExecution` refuses when the entry already has
a document:

    if (original.document || restoredEntries.has(original))
      throw new Error('Original execution attachment requires its original entry construction')

The v1 fork path creates the child through `bootstrapSemanticTargetWithCapture`, which builds and returns the child's
**bootstrap document** (`coordinator/src/fork-controller.ts` passes `owner.document` to `host.withReadyTarget`). By the
time the first prompt asks for an execution attachment, the entry's document exists, so the refusal fires — even
without any UI read (verified: fork → immediate prompt fails).

The commit-log coordinator has its own execution attachment lifecycle, which is why
`host-commit-log-fork-continue.test.ts` passes and SCL forks continue.

## What it means

The fork is created and its inherited history is readable, but the session never reaches a model turn: the
execution attachment is constructed without the "original entry" the fork path requires. The SCL host has
`host-commit-log-fork-continue` coverage; this path (legacy JSONL + v1 seed) does not.

## Fix (2026-11-07)

`createGatewayForkHost` gains `releaseReadyTarget`: after the ready target has been observed, the gateway closes the
fork child's bootstrap document (`coordinator.closeManagedDocument`). With no document left on the entry, the legacy
coordinator can attach the execution attachment on the child's first turn. `host.ts` enables it only when the store is
not the commit log (SCL already works).

Verification: `host-legacy-fork-continue.test.ts` passes (fork → prompt → rewind); on the rc4 build with the fixed
`fork-session.ts`/`host.ts` copied into its gateway, forking a one-turn session and immediately prompting the child
returns `ok`.

Remaining separate gap: deleting a forked child on the legacy store fails with `Original session parent unavailable`;
the continuation test does not assert deletion.

## Workaround

"建立另一個分支" (`fork-fresh`) is a separate path; verify whether it continues before recommending it.