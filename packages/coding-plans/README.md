# @i-harness/coding-plans

Node-side subscription account service. The first provider is OpenAI / Codex.
The existing `@i-harness/llm-openai` Responses adapter remains responsible for model execution.

`createCodexManagement({ directory })` exposes device sign-in/cancel, a redacted state,
account-bound model discovery and token resolution, allowance refresh, explicit reset-card
redemption, sign-out and close. The directory must be dedicated to this service. Windows
files use a protected current-user DACL; POSIX uses 0700/0600. Never serialize the token
resolver's result to a renderer, log, or settings document.

The public account ID binds the verified subject and workspace. Inference receives the
upstream workspace ID and token together; WHAM allowance/reset requests use that same
credential. The protocol follows Codex Rust v0.160.0 and the device-login integration
examined in cc-switch3.20.1. It is a Codex compatibility connection, not an IH-specific
OpenAI client registration. Models and reset eligibility remain server-authoritative.

Reset consumption requires `{accountId, creditId, confirmed: true}`. Every logical
redemption persists an idempotency ID before POST. Unknown outcomes remain pending;
the caller must explicitly retry the same card. Reading state or refreshing never consumes
a card. Caller code must not turn a usage-limit response into automatic redemption.

Run `pnpm --filter @i-harness/coding-plans test` and `typecheck` for signed, offline
fixtures. Real sign-in requires the user's browser authorization. Never use real reset cards
for tests. `trustedTestDependencies` is a process-only test seam, not configuration or IPC.
