# rc2: a new session's first prompt fails with a recovery-gated fact admission

Status: **reproduced, root cause not yet closed** (2026-11-07). Related: [2026-11-06-session-commit-log-status.md](2026-11-06-session-commit-log-status.md).

## Symptom

In the Desktop (0.1.13-rc2, legacy JSONL store), creating a new session in a project, selecting `deepseek-flash`, typing a prompt and sending fails
immediately:

- toast: **請求未完成 / Model request failed (model_error).**
- diagnostics: a single `session/error` entry, `code: "model_error"`, **no `modelFailure` facts**;
- retrying the same session fails the same way; a reload does not visibly repair it.

## Reproduction (portable build, isolated profile)

1. Portable 0.1.13-rc2 with `--user-data-dir=<env>\userdata` and `IH_CONFIG_DIR=<env>\config`;
2. a project bound to an existing folder; `sessionStore` unset (legacy);
3. new session → pick `deepseek-flash` → send `hi`.

The same flow was driven over CDP (`window.ihDesktop.request`): `session/create` (with `projectId` + `clientToken`), `session/model/set`,
`desktop/session/input/submit` — **it succeeds**, including with concurrent `session/history`, `session/context`,
`desktop/session/input/state` and `desktop/session/work-state` reads before or after the submit.

## Evidence

The failing session's journal ends at the preparation barrier:

```
agent/input/admitted
context/action:open
agent/input/preparation:started
agent/input/preparation:completed
conversation/semantics
context/action:close      ← no agent/input/promoted, no turn/start
```

A successful session (same app, driven through the bridge) continues:

```
... conversation/semantics
agent/input/promoted, turn/start, user/message, ...
```

With the packaged gateway's stderr captured, the failing turn reports:

```
[diag] session/error <session> AggregateError: Fact admission requires recovery or was cancelled;
  Original pending-input observation unavailable: Managed facts require reconciliation
  at savingFailure (core-agent/src/agent/saving-failure.ts)
  at Object.failure (core-agent/src/executor.ts)
  at recordError (core-agent/src/executor.ts)
  at completeSubmission (session-executor/src/service/submission-completion.ts)
```

So the turn's fact admission returned a non-committed outcome (`FACT_RECOVERY_REQUIRED`) **before** promotion, and the failure-saving
path additionally could not observe pending inputs ("Original pending-input observation unavailable"). The desktop's recovery gate
(`packages/desktop/src/main/session-recovery.ts`) only reacts to **rejected RPCs**; this failure arrives asynchronously as
`session/error`, so no `desktop/session/reload` happens automatically.

## What is already ruled out

- Provider/API: the same key/model works (direct HTTP 200, and the gateway completes requests for bridge-created sessions);
- Config isolation: the isolated config is valid (gateway starts, provider directory resolves, bridge-driven sessions complete);
- Concurrent history/context/input-state/work-state reads: reproducing them around the submit does **not** fail;
- Model selection: `{provider:"deepseek", model:"deepseek-flash"}` (no reasoning effort) is exactly what the bridge drives successfully.

## Decisive isolation (2026-11-07)

Driving the same gateway sequence over the bridge and adding **one session-scoped read** about 400 ms after the submit makes the turn fail:

| read during the turn | turn outcome |
|---|---|
| none | completes (model connecting / settled / budget) |
| `session/history` | fails |
| `session/context` | fails |
| `desktop/session/work-state` | fails |
| `desktop/session/input/state` | fails (and the desktop reloads the session, then reports "會話狀態已重新載入，請重試") |
| `session/tasks`, `desktop/session/project/state` (different documents) | no effect |

Reads fired immediately (before preparation) do **not** fail; reads fired while the turn is live do. The desktop's own composer trace shows exactly this shape: submit at
`t=…017`, then `session/history`, `session/context`, `desktop/session/work-state` at `t=…440` (after the UI navigates to the new session), and the turn fails.

So the failure is **not** in the draft/durable-input creation; a successful write to the session
(history/context/work-state read) invalidates the in-flight writer (`Original writer dependency cleanup unresolved` / `Original issued write needs reconciliation`,
from `core-session/src/managed/execution-state.ts` `assertFresh`), and the input source is left unreconciled.

## Working hypothesis

A recovery hold on the session's input inbox exists between preparation and promotion in the composer path (the composer is the only
driver that also mounts the new session's UI immediately). The lane then refuses admission with `FACT_RECOVERY_REQUIRED`, and the
failure cleanup cannot reconcile the pending input, leaving the session in a state that retries cannot use.

## Attempted fix (2026-11-07): debt waiters — insufficient

The writer refused admission when any writer-dependency scope was outstanding
(`core-session/src/managed/execution-state.ts`): `assertFresh` threw on any debt scope outside
`taskHistoryScopes`, and `prepareWrite` threw when a debt scope had no admission promise. A patch
introduced per-scope settlement promises, made `prepareWrite` wait for active scopes, and excluded
transient read scopes from `assertFresh`. Core-session tests stayed green apart from the 16
pre-existing `memory-source-checkpoint` failures this environment shows on a pristine tree.

**The packaged app still failed with the same AggregateError, and the added `assertFresh` log
never fired.** So the failing admission is not the transient-read debt path; the refusal is
reported earlier (an admission returning `FACT_RECOVERY_REQUIRED`), most likely the document or
execution `beginAction` refusing because its readiness/bootstrap is not satisfied. The experiment
was reverted.

## Next steps

0. Instrument `createManagedDocument.beginAction` / `document.assertReady` and the execution
   attachment's `beginAction` outcome codes and stacks, and log the document's `bootstrapReady`
   state at admission; compare the failing composer session with a succeeding bridge session;
1. Instrument the **durable** settlement source (`session-persistence-jsonl` / managed facts), not only the nondurable adapter: log
   `hold`/`release`/`requireRecovery` with stacks, then reproduce through the composer;
2. compare the composer's exact RPC trace with the bridge trace (main-process IPC logging), including `desktop/session/input/state` and
   `desktop/session/input/resume`;
3. decide the repair: reject the submit when the inbox already requires recovery so the existing desktop gate fires, and/or extend the gate
   to recovery-gated `session/error` notifications; the durable journal must be repairable by reload.