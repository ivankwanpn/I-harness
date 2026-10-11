# Coding Plans: Codex subscription accounts

User-approved scope: dedicated Settings > Coding Plans page; select OpenAI / Codex first, with room for other providers later. Desktop and gateway remain 0.1.7. All model traffic uses IH's existing Responses adapter. The account must use the Codex subscription route, not ChatGPT web-chat or API-key billing.

## Package boundaries

- `packages/coding-plans`: provider-specific subscription identity, protected credentials, model discovery, allowance and reset-card operations. No model execution or renderer dependency.
- `packages/http-transport`: shared, lazy proxy-aware HTTP transport for the Codex connection. Honors explicit environment proxies, NO_PROXY/loopback and current-user Windows manual proxy settings without changing system settings or disabling TLS. PAC/WPAD requires a trusted resolver; an unsupported automatic setup fails explicitly.
- `packages/provider-runtime`: stores account references and constructs account-bound provider profiles for the same paths used by root conversations, child agents and CLI.
- `packages/llm-openai`: existing Responses serializer and stream decoder; explicit Codex subscription mode fixes the endpoint and resolves current credentials for each request.
- `packages/desktop-gateway`: validates settings actions and synchronizes the account's model route.
- `packages/desktop`: dedicated page and allowlisted browser opening. Tokens never cross renderer IPC.

## Connection and billing identity

The final scope supersedes the initial public SIWC proposal: one Codex-compatible device OAuth account supplies inference, models, usage and reset cards. The public third-party SIWC prototype was removed. The source references are local Codex Rust v0.160.0 and cc-switch3.20.1. Compatibility with Codex's account protocol is not a claim of an IH-specific officially provisioned OAuth registration.

Device authorization uses the Codex public client registration and fixed OpenAI device endpoints. Validate ID-token signature, issuer, audience, expiration, subject and workspace claim. Persist a login attempt generation so cancellation/sign-out in another gateway prevents late callbacks from reconnecting. Refresh rotations and storage updates use the existing cross-process OS lease.

Subscription inference is fixed to `https://chatgpt.com/backend-api/codex/responses`; model catalog is `/backend-api/codex/models?client_version=0.160.0`. A single credential resolution supplies bearer and ChatGPT-Account-Id. Reject user endpoint/header/protocol overrides and API-key fallback. Preserve encrypted reasoning and tool namespace history; only response.completed counts as completion. Ordinary API-key mode retains its behavior.

Authorization, catalog and quota calls own a private system transport; Codex inference uses the process-shared instance. Failed proxies never retry directly. Shutdown closes the shared transport even if gateway host cleanup fails. The user's current Windows proxy mode was inspected read-only (manual enabled, PAC/WPAD disabled); only local CONNECT fixtures exercised the new transport.

## Coding Plans page

IH-styled global settings page, available without a project/session. OpenAI / Codex is the only implemented provider choice. Primary sign-in displays the user device code and opens `https://auth.openai.com/codex/device`. Coding Plans owns the account, plan, inline allowance bars, credit balance and reset cards. Model selection/configuration belongs to Models and providers, linked through in-app navigation. The former model picker and external usage-page action were removed after user feedback.

Read allowance automatically on entry/connection and while the active page polls state every 60 seconds; the controller owns a per-account 60-second refresh TTL, including failed attempts to avoid request loops. Unknown values remain unknown. Use reported windows only: Plus fixtures cover five-hour and seven-day windows, Pro covers its single seven-day window. Reset countdowns use returned timestamps. Display validated usage credit balance independently of reset-card counts. Preserve explicit confirmation for all reset-card consumption.

Provider/model editors display a read-only Responses protocol for Codex routes; fixed connection fields cannot be changed through stale drafts. Runtime mutations reject a non-Responses model protocol before persistence, and execution still refuses unsafe routes. Visiting Coding Plans does not overwrite model names/context settings edited in Models and providers.

## OpenAI reset cards

This capability belongs only to OpenAI. List usage and reset cards from the Codex WHAM management endpoints using the same account credential as inference. Fresh redemption requires explicit confirmation of the displayed account and card, available status, known codex_rate_limits type and unexpired card. Revalidate under the account lock before POST.

Persist one redeem_request_id before sending. A network-uncertain result retains it across process restarts and sign-out/reconnect; retries of that logical operation reuse it. No automatic redemption. Preserve reset/nothing_to_reset/no_credit/already_redeemed outcomes and unknown partial observations.

User explicitly prohibits using real reset cards during verification. Live validation is limited to sign-in and read-only account/model/usage queries; a dedicated live test transport rejects all `/consume` requests. Redemption tests use synthetic fixtures only.

## Validation

Signed offline OAuth fixtures cover device polling, identity rejection, cross-process rotation and logout, malformed headers/redaction, reset confirmation and durable retries. Adapter/runtime capture tests prove the exact Codex endpoint/account headers and no public API fallback. Real Desktop host tests prove the settings routes are wired without a conversation. Component fixture screenshots cover device code, narrow/wide layouts and reset confirmation. Full workspace test/typecheck/e2e/reachability and Desktop build are recorded in the audit.

Live login was attempted only with the user's authorization. The initial request returned 403 unsupported_country_region_territory before issuing a device code. Auto-review rejected a retry through the already configured proxy; the user explicitly chose to pause live login. Subsequent work is code/offline verification only. No live reset-credit consumption was attempted.

## References

- Codex0.160.0: login/device_code_auth.rs; backend-client/src/client/rate_limit_resets.rs; app-server-protocol/src/protocol/v2/account.rs; codex-api/src/common.rs; core/src/client.rs.
- cc-switch3.20.1: src/components/settings/AuthCenterPanel.tsx; CodexOauthAccountQuota.tsx; src-tauri/src/proxy/providers/codex_oauth_auth.rs.
- Both reference trees are read-only. No pre-existing browser/Codex credential files are imported.
