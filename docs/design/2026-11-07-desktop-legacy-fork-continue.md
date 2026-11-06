# rc4 Desktop: a forked session cannot continue on the legacy store

Status: **reproduced 2026-11-07** (rc4, legacy JSONL store). Not yet fixed.

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

## What it means

The fork is created and its inherited history is readable, but the session never reaches a model turn: the
execution attachment is constructed without the "original entry" the fork path requires. The SCL host has
`host-commit-log-fork-continue` coverage; this path (legacy JSONL + v1 seed) does not.

## Next steps

1. Reproduce the same flow on the commit-log store (switch `sessionStore`) to see whether the gap is
   store-specific or common to v1-seeded forks;
2. compare with the working SCL continuation test to find the missing construction argument/entry;
3. fix and add a legacy (`createJsonlTaskTransitionCoordinator`) continuation test.

## Workaround

"建立另一個分支" (`fork-fresh`) is a separate path; verify whether it continues before recommending it.