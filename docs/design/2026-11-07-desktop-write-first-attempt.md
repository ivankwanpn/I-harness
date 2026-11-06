# rc3 Desktop: the first write in a fresh session fails as "unseen-rules"

Status: **reproduced in the packaged app, underlying exception not yet captured** (2026-11-07).

## Symptom

In a fresh rc3 session (workspace without AGENTS.md/CLAUDE.md), asking the agent to write a new file produces:

- UI: **檔案變更 <path>** followed by **執行失敗**;
- session fact: `tool/result` for `write` with
  `{"execution":{"outcome":"failed","dispatch":"not-dispatched"},"value":{"code":"INSTRUCTIONS_REPLAN_REQUIRED","reason":"unseen-rules","currentFingerprint":"c820…"}}`;
- the model then spends several steps searching for AGENTS.md / rules, retries the write, and the **retry succeeds** and creates the file.

So the file is eventually written, but the first attempt always fails with a misleading reason.

## Where it comes from

`packages/session-executor/src/context/instructions/manager.ts` (`preflightCore`):

```ts
try { … prepare(targets); resolveInstructionCanonical(…); proveApplicable(…); install(…) … }
catch (error) {
  if (signal?.aborted || isInstructionReplan(error)) throw error
  throw fail('unseen-rules')          // ← the real exception is discarded
}
```

The `unseen-rules` label is a catch-all. The code also retains the target selection before
asynchronous resolver work ("a rejected batch still informs the next normal request"), which explains
why the immediate retry passes.

## Not yet established

- the underlying exception (the catch masks it); the packaged gateway's stderr is not forwarded by the
  Desktop main process, so a diagnostic patch was needed to capture it;
- whether the first-write refusal is intended when there are no instruction files at all (no AGENTS.md
  in the workspace, no global sources present), or a regression.

## Next steps

1. Capture the real error by patching the packaged `manager.ts` catch to log the stack and reproducing a
   first write in a fresh session (env app already has the stderr forward patch);
2. reproduce headlessly in the gateway test harness with a controlled model that calls `write`, so the
   failure has a repo test and the real exception is visible;
3. fix: preserve/log the cause and only use `unseen-rules` when rules are actually unseen; make the
   first write in an instruction-free workspace succeed.
