# Desktop reviewer isolation and provider UI — 2026-09-30

The previously listed workflow/streaming/Agent Shell/reviewer reuse work is completed in [desktop-workflow-completion-qa.md](2026-09-30-desktop-workflow-completion-qa.md). Its accepted package hash and fine-grained inventory supersede the older remaining-work list below.

The later removal of unnecessary setting restarts and Skills-page redesign are recorded in [2026-09-30-live-settings-and-skills-ui.md](2026-09-30-live-settings-and-skills-ui.md), which also contains the latest package hash and verification results.

Worktree: `D:\frontend-test`, branch `codex/desktop-workbench`, starting commit `70341a06`. The QA workspace was `D:\agent-complete\playground`. Source changes were kept out of `D:\I-harness-main`; nothing was pushed. The user's pre-existing `packages/desktop/electron.vite.config.ts` change is excluded from the local implementation commit.

## Completed

- Desktop delegated approval now uses a dedicated internal `ModelClient.stream` request with an empty tool list. It creates no ordinary Agent, subagent job or durable chat session for each review. The pending operation and bounded recent context are its input, and its result must satisfy the existing JSON verdict contract.
- The reviewer independently resolves `agents.roles.reviewer` at the next approval check. Its provider, model and reasoning effort can be selected even when the ordinary task-subagent model switch is off. Missing selection uses the parent model client; the main conversation's reasoning effort is not implicitly imposed on the reviewer.
- Parent cancellation aborts review and propagates cancellation. Reviewer timeout, invalid output or operational failure follows Desktop's human-approval fallback; an explicit model denial remains a denial. Arguments that would be truncated by the reviewer envelope require human approval instead of being reviewed incompletely.
- New compatibility-path reviewer logs have `origin: approval-review`. Explicit internal reviewer logs and older zero-seed subagent logs with the exact guardian envelope are excluded from normal listing, dashboard and archived conversation navigation. Original logs remain intact. Ordinary children and user copies of the same text remain visible. Direct history and content search remain diagnostic access paths.
- Persisted selection of a conversation no longer in the visible listing is reconciled during startup. Retry and StrictMode use the original restored selection snapshot, so a later user selection cannot be cleared by an earlier bootstrap request.
- Subagent settings now use inline cards with a combined provider/model dropdown grouped by provider, plus English reasoning effort choices. Selecting a value saves directly. The reviewer has its own card; there is no protocol selector. Same-model effort edits preserve legacy protocol overrides; changing the model drops that override and uses managed model metadata.
- Provider creation and editing no longer expose a provider protocol selector, and the provider summary no longer has a protocol row. Models retain protocol editing. Existing backend provider defaults remain readable for compatibility and are not erased by unrelated provider edits.
- Model discovery uses the existing OpenCode-adapted button, a dedicated discovery panel, a search input and selectable model rows. A probe uses the legacy route protocol or the single declared protocol among existing models. Its returned rows retain the discovery protocol when imported, and existing model overrides retain precedence. A new custom provider with no declared wire needs a first manually configured model before discovery; ambiguous protocol declarations require manual model entry.

## Reference comparison

The local Codex CLI source at `D:\agent-complete\codex-rust-v0.154.0` distinguishes guardian reviews via `ThreadSource::GuardianReview` (`codex-rs/core/src/codex_delegate.rs`), applies a dedicated reviewer configuration (`core/src/guardian/reviewer_config.rs`) and implements reusable internal review sessions (`core/src/guardian/review_session.rs`). The guardian-v2 configuration also uses `SessionSource::Internal(InternalSessionSource::Guardian)` (`ext/guardian-v2/src/sync_reviewer/reviewer_config.rs`).

This change adopts separation from user conversations and tool execution through a direct request. It does not reproduce Codex's review-session pool or claim that the closed-source Desktop UI has been inspected. The generic subagent runner remains available for compatibility in other hosts; Desktop explicitly selects the isolated runner.

The inline card and discovery layout were compared with the local OpenCode fork's `packages/app/src/components/settings-v2/agents.tsx` and `packages/app/src/components/dialog-custom-provider.tsx`. React components and the existing Desktop tokens are used, without adding a Solid runtime.

## Verification

- The initial full-gate attempt ended with only 51/70 projects reporting and is not counted as a passing run.
- A subsequent `pnpm verify:all` passed: **3,709 passed, 9 skipped, 0 failed; 70/70 projects reported; typecheck, five E2E files and reachability passed.** Log: `D:\frontend-research\desktop-reviewer-provider-final-verify-2026-09-30-retry.log`.
- After the final bootstrap-selection review fix, **21/21 App selection tests** passed, including unavailable-listing retry and StrictMode replay, followed by a passing Desktop typecheck. The full-gate run above contained 19 App selection tests; the final two regressions were verified in the focused run.
- Source tests also exercise no child-session creation across consecutive reviews on two independently selected clients, real JSONL legacy-log visibility across restart, cancellation, timeout fallback, incomplete verdict rejection, UI save failure, protocol inheritance preservation and model discovery protocol import.
- `pnpm --filter @i-harness/desktop dist` succeeded. Log: `D:\frontend-research\desktop-reviewer-provider-dist-2026-09-30.log`.
- Packaged Electron QA used **actual configured DeepSeek Flash**, with isolated copies of settings/credentials and temporary userData. The main conversation ran at **Max**, the independently selected reviewer ran at **Low**, and the ordinary subagent model gate remained false. The task completed **two tool calls and two tool results**, with one provider reasoning block. Both visible and raw durable session counts were **one** after completion. No reviewer chat was created.
- Actual DeepSeek discovery returned **two** models. Import preserved the existing model's context and input-modality overrides. Provider and subagent settings measured `scrollWidth === innerWidth` at 900px. The screenshots were inspected at normal and narrow sizes.
- Live QA log/script: `D:\frontend-research\desktop-reviewer-provider-live-qa-2026-09-30.log` and `.mjs`. Temporary test config and userData were removed after the app closed; normal installed settings were not changed.

## Local package and screenshots

- ZIP: `D:\frontend-test\packages\desktop\release\I-harness-Desktop-0.1.0.zip`
- SHA-256: `64091006164B30CC3BA1C26951A719256789F4162AEDF05A5051CFA8E0D12C59`
- App: `D:\frontend-test\packages\desktop\release\I-harness Desktop\I-harness Desktop.exe`
- Provider exploration: `D:\frontend-research\desktop-provider-explorer-1280-2026-09-30.png` and `desktop-provider-explorer-900-2026-09-30.png`
- Reviewer settings: `D:\frontend-research\desktop-reviewer-inline-1280-2026-09-30.png` and `desktop-reviewer-inline-900-2026-09-30.png`
- Live result: `D:\frontend-research\desktop-reviewer-live-finished-2026-09-30.png`

## Remaining work inventory / stop point

1. **Credential-backed protocol acceptance:** actual Claude Anthropic, GPT Responses, Gemini and Bedrock still require their own credentials and live execution. Local official-wire tests do not establish production acceptance for those providers.
2. **Legacy signed thinking:** old Anthropic continuation migration/fallback still needs real Claude preserved-thinking acceptance before changing the compatibility policy.
3. **Reasoning display timing:** multiple blocks are stored and expandable; immediate streaming display within a long block still needs a short-batch event path.
4. **Agent shell selector scope:** the terminal setting controls newly opened human terminals. Agent bash/pwsh retain their declared dialects; extending the setting to them needs coordinated runtime and approval-parser work.
5. **Additional workflow surfaces:** durable job history, team roster/task board, Goal mutation and a Plan Mode control still need their Desktop producer/lifecycle/routes. Existing live task and Todo views are present.
6. **Reviewer reuse and history:** an internal review-session pool/cache and a dedicated review-history UI are not implemented. The current direct request solves per-tool ordinary-chat creation, but makes a separate provider request for each delegated review.
7. **Deferred account/UI features:** provider usage/reset/OAuth, unmounted browser-control settings, keyboard shortcut settings and statistics pages remain deferred. The portable package remains unsigned.

These are inventory items, not instructions to resume work. Stop after delivery, as requested.
