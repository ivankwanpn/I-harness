# Chat terminal-error and observed-usage scoped acceptance

Accepted after fresh independent review and same-reviewer ImportantI1 correction: worktree commits3422c562 andbf3dac6b, integrated into MAIN as61bc027c and410cf3ac. Exact originalBASEfc71742d. This is one R5 repair; automatic partial-discard retry and broader recovery remain incomplete.

The actual Chat fold/parser now recognizes explicit error carriers at normal/residual SSE boundaries, preserves legitimate line framing, emits no later clean completion/tool flush, and closes its owned reader. Classification reuses existing bounded canonical facts, including model-capacity's10second retry policy, without inventing HTTPstatus or retaining raw provider error payloads. Real provider-runtime/local HTTP/managed SessionService tests demonstrate no failed tool effect or accepted calibration and successful subsequent work on the same assembly.

Observed usage remains billing evidence for each physical attempt, including retry/exhaustion and genuine Stop/control failure. The correction preserves original failure identity, exactly one report and zero extra send/effect/accepted anchor. It does not treat reported usage as successful model acceptance.

Initial scoped checks:195Chat,158seam,65supportedAgent,14connected/session and4package types passed. Correction checks:44retry/wait/execution,23Agent,12connected and3types passed; these overlap, not a summed total. Root independently checked12final owned file hashes/actualGit blobs plus101indexed evidence files. Same fixed integratedHEAD410cf3ac then passed12realChat connected controls and16transfer composition controls sequentially, with2809source/configfile hashes identical before/after and all12integratedChatblobs equal the reviewed source.

[Original review](chat-terminal-review-20261024/task-1-review.md), [same-reviewer correction](chat-terminal-review-20261024/task-1-fix1-review.md), [full report](chat-terminal-review-20261024/task-1-report.md), [root audit](chat-terminal-review-20261024/root-audit.json) and [integrated record](chat-terminal-review-20261024/integrated-result.json) preserve exact claims. Raw source-bound evidence remains atC:/ih-r5-evidence-20261023 andC:/ih-r5-fix1-20261023; the report copies are not a portable copy of every fixture.

Remaining blockers/limits:

- Automatic partial-output discard retry is permitted by existing retry policy but fails `CONTEXT_INPUT_STALE` before its second physical send. Safe refusal/new-submit success is not automatic recovery. Integrated planTask2 owns this concrete defect.
- Six fallback `model-recovery` failures remain. Restoring three changed owners reproduced the same failures in an otherwise modified checkout; this is not a clean whole-BASE reproduction. MinorM1's old successful-only usage assertion must be updated with the real recovery repair.
- A custom throwing telemetry observer during retry cannot receive an upstream error object absent from the existing retry-event contract. Standard telemetry isolates sink failures. No broader event schema was added just for this observer case.
- This does not diagnose the historical fourHTTP400s, qualify every protocol/native route, or complete R5/long-session/integrated release acceptance. Product remains0.1.13-rc.1/Session11; no publication or pure-decomposition credit.
