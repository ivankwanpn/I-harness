# Coding Plans page refinement

User confirmed the first installer can authorize a real account, retrieve models and run an IH conversation. Their manual refresh also displayed Pro's weekly allowance. This revision addresses the page's responsibility and presentation; no live account operations were performed by the agent.

## Changes

- Removed Coding Plans model selection and its use-model IPC action. An in-app Manage models action opens Models and providers.
- Removed the external usage-page card/action, which the user reported redirected to the ChatGPT website.
- Consolidated account/plan, allowance progress, reset countdowns, returned credit balance and reset cards into a compact IH-styled layout.
- Show only reported allowance windows. Synthetic Pro coverage has one weekly window; Plus has five-hour and weekly windows. Unknown quota/balance does not become zero.
- Controller state requests refresh allowance automatically with a per-account 60-second TTL; the active connected page polls state every 60 seconds. Failed reads preserve account controls and respect the retry interval.
- Codex provider/model editors lock Responses and managed connection fields. Backend add/edit/upsert validation rejects incompatible model protocols before saving. Directory data carries the explicit oauthProvider identity used by the UI.
- Opening Coding Plans preserves model edits in Models and providers instead of replacing its model catalog on every state read.

## Verification

Targeted tests: **238 passed** across non-overlapping runs:

- coding-plans: 30
- provider-runtime: 78
- gateway controller/provider-wire/real-host: 23
- Desktop Coding Plans bridge/UI, provider editor/directory, settings navigation and localization: 107

Desktop and gateway typechecks passed; reachability passed with 423 existing rows and no new exceptions. New regressions were observed failing before the protocol-write, auto-refresh, model-preservation and retired external-action fixes.

Actual component + IH CSS in a synthetic shell: **14 screenshots / 24 checks**, no renderer exceptions, mutations or horizontal overflow. Captures cover 1440/900 widths, Pro/Plus, dark/light Traditional Chinese, pending login, unknown data and reset confirmation. Evidence: `.tmp/coding-plans-refinement-qa/evidence.json` and `visual-review.md`. Screenshot figures and balances are synthetic, not a read of the user's account.

Final review identified additional model-specific quota names being lost during duration localization. The service now exposes an optional scopeName independently of limitSeconds, and the UI preserves both; an additional scoped-window fixture and screenshot cover distinct primary/model-specific weekly limits. Evidence: `.tmp/coding-plans-refinement-qa/scoped-evidence.json`.

The retained Models and providers pane now refreshes on reactivation, so a provider connected from Coding Plans appears without restarting. Two regressions cover preserving unsaved drafts and rejecting old in-flight directory responses.

The earlier full-workspace 6,240-pass result belongs to the previous revision. This refinement uses the targeted checks above and its new build/artifact checks; it does not claim a new full-workspace run.

Version remains 0.1.7. Real reset cards are never used for testing. Model inference, private credentials and the user's installed profile were not accessed during this revision.
