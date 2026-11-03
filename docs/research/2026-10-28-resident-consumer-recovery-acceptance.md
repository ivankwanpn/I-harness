# Restored resident instructions and original recovery — bounded integration

The restored-resident instruction consumer and its original publication/generation cleanup repair have passed independent implementation review and scoped rereview. Donor commits `a873392146358cabefa765b894f3238b1de9a1fd`, `4ccbc6673131407e849e9af88f352e0f101e67ff` and `b59520f6b00e184526c8655b494613e2adac4655` are integrated into MAIN as `2ff919d4`, `7bd0e513` and `e0a7cb38`. Commit messages preserve their historical unaccepted/WIP checkpoint labels; this document records the later bounded acceptance.

A cold-restored resident now acquires its own original instruction lease before its actual model request, and real Code Mode reads/lists use that same child view. Its Session lease survives turn interruption and a distinct genuine inbox. Permanent retirement fences new work before original generation, result, instruction, document and host cleanup.

The actual unknown-publication failure is repaired without replaying a prompt or creating another generation: settle the original publication, recover the same captured close, then acknowledge source/lifecycle cleanup before releasing the lease and document. Ordinary close retains its original attempt result; an explicit recovery capability retries the original receipt. The original clock, disposition, methods and receivers remain bound. Concurrent and delayed cleanup records share the exact preparation's publication outcome until the outer attempt's last borrower exits; only a later explicit attempt can retry.

An added active physical-interruption control exposed and repaired a separate driver defect. New-work cancellation previously invalidated the already admitted source needed to retain the cancelled result. Admission still requires current execution; after actual source acquisition succeeds, only that original terminal result remains retainable through Stop/removal/replacement until acknowledgment. A stale late source does not gain that lifetime, and no new model/tool execution is authorized by it.

Root independently verified MAIN with fresh isolated roots after integration:

| Scope | Root result |
| --- | --- |
| Full actual resident consumer and real managed close recovery | 39 passed in two files (23 + 16) |
| Original prerequisite/falsey/concurrent cleanup controls | 13 passed in one file |
| Complete packages tree versus accepted donor | Exact tree identity `a5c1b661bd7de0374e7d02468aeb303caac086d6` |

Both root commands exited zero, test sources remained unchanged and there were no tracked package edits. Evidence is under the plan-owned `R3-root-integration/a9006175739c42fd954cb75d17365816` and `R3-root-integration/dd9e9f7802744a43a4169943c1381b2e`, with exact commands, tools, six fresh roots, exits and source checks. Donor fixed evidence separately contains 99 subagent and 92 executor passes plus two refreshed type checks; earlier unchanged type/runtime receipts retain their original scopes. Those overlapping populations are not summed into a full-version count.

The enabled semantic-fork-to-child-seed regression remains open. The existing raw `forkTurns`/remapper retains semantic seed records but validates its output without the required semantic birth header. Logical public-fork projection already succeeds; the child inheritance adapter is the missing boundary. Its correction belongs with the planned semantic child caller, preserving original source provenance and effective inherited/observation authority. The original failure and explicit test-oracle migration remain visible; no parser bypass, raw-log fallback or expected-error replacement was used to claim the positive completed.

This accepts the bounded restored consumer and recovery code. It does not establish whole R3/R4/R5 qualification, fresh child/all-N/Team/reviewer instruction support, all long-session protocols, complete internal event driving, or a usable release. The historical simultaneous-result incident remains unattributed. Product is still 0.1.13-rc.1 / Session13; user explicitly requested continued development and no release.
