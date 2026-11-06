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

## Working hypothesis

A recovery hold on the session's input inbox exists between preparation and promotion in the composer path (the composer is the only
driver that also mounts the new session's UI immediately). The lane then refuses admission with `FACT_RECOVERY_REQUIRED`, and the
failure cleanup cannot reconcile the pending input, leaving the session in a state that retries cannot use.

## Next steps

1. Instrument the **durable** settlement source (`session-persistence-jsonl` / managed facts), not only the nondurable adapter: log
   `hold`/`release`/`requireRecovery` with stacks, then reproduce through the composer;
2. compare the composer's exact RPC trace with the bridge trace (main-process IPC logging), including `desktop/session/input/state` and
   `desktop/session/input/resume`;
3. decide the repair: reject the submit when the inbox already requires recovery so the existing desktop gate fires, and/or extend the gate
   to recovery-gated `session/error` notifications; the durable journal must be repairable by reload.
