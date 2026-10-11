# Coding Plans implementation and verification

Branch: `codex/coding-plans-chatgpt`, based on `42dd86bed552b28271063e2ffe3c7b4f337d67e4`.
Desktop and desktop-gateway versions remain **0.1.7**.

## Delivered behavior

- Dedicated global Settings > Coding Plans page, first provider OpenAI / Codex.
- One Codex-compatible OAuth account supplies model catalog, model credentials, allowance and reset-card management. No separate public SIWC inference connection remains.
- `@i-harness/coding-plans` owns verified identity/workspace, protected token persistence, account generation, cross-process refresh/logout and durable reset idempotency.
- `@i-harness/http-transport` owns environment/Windows manual proxy selection, bypass, cancellation and cleanup. Codex auth/catalog/usage and existing Responses adapter subscription calls use it. No global dispatcher or system proxy setting changes.
- Existing Responses adapter sends subscription traffic only to `/backend-api/codex/responses`, using token and account header from the same resolution. No API-key billing or endpoint fallback.
- Catalog refresh replaces removed/changed/empty account model snapshots. Wrong-account operations and unsupported direct audio/protocol overrides fail before resolving credentials.
- Reset cards require account/card confirmation. Unknown outcomes retain the same persisted redemption request ID. No automatic redemption, and unknown/expired/unsupported cards cannot start a new redemption.

## Final verification

`pnpm verify:all` completed with exit **0**:

| Check | Result |
| --- | --- |
| Workspace suite | **6,240 passed, 21 skipped, 0 failed** |
| Project population | **80 / 80** reported |
| Typecheck | exit 0 |
| e2e | exit 0; 6 files / 13 tests |
| Reachability | exit 0; 423 existing rows, no new exemptions |

Log: `.tmp/coding-plans-verify-complete.log`.

Focused verification included coding-plans 26 tests, HTTP transport 12 local tests,
Responses adapter 65 tests, provider 149 tests, provider-runtime 77 tests, gateway
controller/real-host tests, and Coding Plans UI/navigation/localization tests.
Independent final static review found no confirmed P1/P2 issues.

Earlier full runs exposed three fixture issues that were corrected without disabling
assertions: structuredClone discarded AbortSignal methods in independent replay;
WorkflowJobs output tests clicked before the mount effect settled; the search fixture
paid excessive Windows process startup for twenty tiny files. The latter now uses ten
denser files while retaining 240 hits, ten groups, twenty group candidates, ten emitted
references, real scoped subprocesses and the same 15-second deadline. Native per-file
process startup remains a separate performance consideration.

## Build and UI evidence

- `pnpm --filter @i-harness/desktop build`: exit 0. Log `.tmp/coding-plans-build-final.log`.
- Gateway shipment to `.tmp/coding-plans-shipped-gateway`: **237 runtime packages** copied successfully.
- Actual shipped gateway subprocess initialized and returned redacted disconnected Coding Plans state without a session. Evidence `.tmp/coding-plans-shipped-smoke/evidence.json`.
- Actual isolated Electron app opened Settings > Coding Plans without a project or credentials. Screenshot `.tmp/coding-plans-qa/native-electron-disconnected.png`.
- Actual React component plus IH CSS, synthetic account data, isolated Chrome: **11 screenshots and 13 layout/eligibility checks** at 1440/900 widths, including Traditional Chinese light theme. Evidence `.tmp/coding-plans-qa/evidence.json` and `visual-review.md`.

The synthetic connected/quota/card screenshots are not evidence of a real account
authorization or quota balance. The native app check verified the disconnected page.
This turn built Desktop output and an independent gateway shipment; it did not replace
the installed app or publish a new installer/release.

## Live account boundary

The user allowed login but explicitly prohibited consuming their reset cards. The
first direct device authorization request returned HTTP 403 with
`unsupported_country_region_territory`, before a device code or credentials were issued.
Auto-review rejected retrying through the already configured local proxy because of
the possible region-control implication. The user then explicitly chose to pause live
login and finish code verification. No proxy-based live retry followed.

No real reset-card consume request, live inference or quota consumption occurred.
The live acceptance helper also rejected every `/consume` URL independently of UI
state. All redemption/retry tests used synthetic fixtures. The current Windows proxy
was read-only inspected as manual enabled, PAC and automatic discovery disabled.

## Limits

Real account acceptance, live Codex model entitlement and external proxy connectivity
remain unverified after the user's pause. The implementation follows the inspected
Codex v0.160.0/cc-switch3.20.1 compatibility protocol; it does not claim an IH-specific
official OAuth client registration. PAC/WPAD needs a trusted resolver; SOCKS/CIDR bypass
are outside this HTTP transport's implemented scope. These cases fail explicitly or
remain documented rather than silently taking another billing/network route.
