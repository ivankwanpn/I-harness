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

## Root cause (captured 2026-11-07)

With a diagnostic log in the catch, a controlled-model gateway test (`host-write-first.test.ts`, write
with `{path, text}`) shows the exception that is masked:

```
[diag] instruction preflight failed: Error: Target instruction evidence not issued
```

It comes from `packages/instructions/src/service.ts` `proveApplicable`: the admission snapshot (`issued`)
has no complete target covering the file being written, so `prior.discovery.targets` yields no
`compatible` entry and the function throws. The preflight catches everything and reports `unseen-rules`.
The retry works because `preflightCore` retains the new target and the next admission's snapshot
includes it.

So each **new target path** costs one failed write; with no AGENTS.md/CLAUDE.md in the workspace this is
pure noise and the model burns steps searching for rules that do not exist.

## Fix direction

- If the current discovery has **no instruction candidates for the target** (empty projection/slots),
  allow the mutation without `proveApplicable` — there are no rules to withhold;
- only report `unseen-rules` when rules are actually unseen; otherwise preserve/log the cause.

## Repro

`packages/desktop-gateway/test/host-write-first.test.ts` (kept skipped while the fix is pending).

## Next steps

1. Capture the real error by patching the packaged `manager.ts` catch to log the stack and reproducing a
   first write in a fresh session (env app already has the stderr forward patch);
2. reproduce headlessly in the gateway test harness with a controlled model that calls `write`, so the
   failure has a repo test and the real exception is visible;
3. fix: preserve/log the cause and only use `unseen-rules` when rules are actually unseen; make the
   first write in an instruction-free workspace succeed.