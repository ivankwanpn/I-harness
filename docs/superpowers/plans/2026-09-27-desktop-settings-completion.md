# Desktop settings and interface completion

User steering: interface completeness and settings are the priority. Earlier integration delivered backend-connected surfaces but did not finish the settings product. Provider account usage/reset/OAuth remain excluded. Continue autonomously; use existing packages before creating new responsibilities. No GitHub push or edits to D:/I-harness-main.

Latest scope correction: defer keyboard-shortcut settings and data/statistics pages. Do not build Agent browser-control settings without existing backend support. Source inventory finds only Desktop's human-operated WebContentsView surface and its IPC, with no built-in Agent browser-control implementation in packages/apps. Keep that distinction; no new browser automation backend this round. Prioritize visual polish and Agent settings adapted to actual I-harness package contracts, not ZCode's runtime assumptions.

## Current evidence
SettingsPane currently has only general/workspace/about, a150px inner navigation, and provider/session management mixed into workspace. ZCode live Electron at its existing localhost:5174 was launched and inspected through Playwright Electron; real settings replace the workspace sidebar, use grouped icon navigation and a consistent main content column. Screenshot saved outside repo under zcode-research/settings-models-live-2026-09-27.png. This is a reference-app inspection, not a workaround for the previously denied localhost:5173 page.

## Work order and acceptance
- [x] Full-window settings layout replacing workspace navigation, grouped/searchable section navigation, remembered section and narrow layout. Reuse existing Apache-attributed presentation pieces and real reference dimensions. Implemented; final visual comparison remains pending under the final verification item.
- [x] Split working controls into General, Appearance, Notifications, Models/providers, Memory, Plugins and Workspace/session pages; use coherent page headings, descriptions, card spacing and states. Agent pages gated by advertised backend capabilities; workspace-specific views keyed by workspace.
- [ ] Agent/execution settings: expose supported sandbox/approval and automatic-compaction defaults, state provenance and precise effective-time feedback; follow existing backend policy rules.
- [ ] Direct MCP settings and live lifecycle, skills/commands management, hook configuration/trust and subagent model settings through owning backend packages.
- [ ] Local-data preferences supported by existing backend; no dead controls or fabricated backend state. Browser-control settings, keyboard-shortcut settings and data/statistics pages are deferred per user correction.
- [ ] Model/provider page redesigned as selectable provider list/detail with model list/detail, search and clear edit/save/clear semantics instead of one long collection of forms.
- [ ] Workbench gap pass: composer context/attachments and task navigation/action accessibility, then remaining supported daily-workflow surfaces discovered in the inventory. Preserve this backlog; do not claim overall UI completeness after only splitting tabs.
- [ ] UI tests + actual permitted Electron reference comparisons, backend integration tests where behavior changes, independent review, local commits and fresh portable delivery. Existing denied browser access is not bypassed.

Reference settings categories inspected from source: general, appearance, modelProvider, browser, shortcuts, memory, subagents, plugin, mcp, skill, commands, hooks. Reference usage/coding-plan/account/OAuth are not part of this scope. Local automations remain a separate workspace workflow, not a settings tab.

## First settings batch, 2026-09-27

Custom-provider reference scope narrowed by user to the existing custom-provider detail. Read ProviderCardSections, ProviderDraftSave and model draft code, alongside direct Electron observations. ProviderDirectory now selects one provider/detail, scopes forms by workspace/provider, shows compact visible model rows, and retains backend-owned mutations and write-only credentials. General/appearance/notifications/models/workspace/about are separate functional sections. Memory/plugins and remaining settings pages are still outstanding; provider model search/editor refinement is also outstanding.

Fresh verification: Desktop 176 tests passed, typecheck and production build passed. Independent review found hidden search at narrow widths could trap filtered navigation; fixed by retaining the editable search control. No final visual parity claim or rebuilt portable release for this intermediate batch. Reference report outside repository in zcode-research/custom-provider-reference-2026-09-27.md.

## Agent settings batch, 2026-09-27

Connected existing memory and plugin views inside Settings without duplicate headings/padding. Added execution/context defaults via desktop-gateway's adapter over SettingsStore: only sandboxMode and compaction.auto are writable. Uses the same file lease as provider-runtime before loading/writing to prevent cooperating Desktop processes from overwriting concurrent provider edits. No new persistence system or sandbox engine.

The gateway captures both settings at startup, so the UI shows saved defaults separately from the currently effective startup policy and states that Desktop restart is required. Per-model context windows remain in model configuration; no GPT-specific billing switch. Independent approval-policy controls are not fabricated; current interaction/sandbox backend continues to determine approvals. Remaining execution-settings acceptance: document exact policy semantics while completing the broader Agent pages.

Verification: gateway 73 tests and Desktop 179 tests passed; both typechecks and Desktop build passed. Tests include real host restart, concurrent provider/settings writes, damaged settings refusal, capability-based UI navigation and scoped IPC. Independent read-only review found no actionable issues. Whole-project verification reported 3419 passed, 9 skipped and one CLI plugin-mount test exceeding its existing 5000ms deadline; typecheck, E2E and reachability passed. Isolated plugin-mount rerun passed all five tests in 139ms; no CLI changes were made. This is not recorded as a fully green verify:all run. Visual polish added to setting toggles, focus, disabled states, with reduced-motion/forced-colors handling; final visual comparison and portable packaging still pending.

Next concrete alignment: Desktop gateway lacks the CLI's roleSelectionFor / resolveRoleModel / allowSubagentModelSelection adapters despite those existing in session-executor. Complete those before presenting role-model settings. Further source findings saved outside repo in desktop-audit/agent-settings-followup.md.

## Subagent model settings batch, 2026-09-27

Completed the previously missing Desktop host adapters: roleSelectionFor reads the settings document at spawn/resume boundaries, resolveRoleModel uses the existing provider runtime, and allowSubagentModelSelection retains the existing startup gate. The synchronous role seam is satisfied by a boundary-time file read, without an idle watcher or duplicate registry. Atomic settings writers preserve complete snapshots. The role UI lists built-ins and configured overrides, permits custom existing-role names, edits provider/model/protocol/reasoning, and removes overrides to restore the role-definition fallback (which may itself specify a model). It never invents a role or grants tools.

Added a shared settings-file adapter extracted from the execution-settings writer; both use the provider file lease. The role enable toggle clearly requires restart; role mapping writes apply to the next new child. Capability-gated Settings navigation mounts the page for the selected workspace only.

Verification: gateway full suite 75 passed; Desktop full suite 180 passed before an additional read-order regression test was added. The two subagent UI tests then passed, including delayed retry results not overriding a newer saved mapping. Both package typechecks and Desktop build passed; reachability gate passed. A real Desktop host with a guarded loopback mock provider proved one session spawning a child on small-one, then small-two after an in-session settings edit. Independent review reported no actionable findings. No paid-model calls are needed by the final guarded fixture. Whole-project verify:all remains at the preceding documented CLI timeout result; no claim of a new all-green global run.

Still outstanding: direct MCP configuration/live lifecycle, skills/commands management, hook trust refresh, provider editor polish, attachment/context flows, final visual validation and portable packaging. The earlier next-action note above is historical and resolved by this batch.

## Hook trust batch, 2026-09-27

Added a capability-gated Hooks trust page for hooks declared by enabled plugins, including source/event/script/hash, invalid configuration diagnostics, explicit content confirmation for grants, and revocation of saved hashes (including grants whose plugins are currently disabled). This page does not claim to configure or mount the harness-home hooks file. All grants use existing hooks trust storage; the gateway re-enumerates plugin declarations and verifies bytes before approving the displayed identity/hash, and serializes cooperating trust writers.

Extended the existing HookRegistry with refreshTrust: it revalidates mounted handlers without replaying session lifecycle, prevents new gates from proceeding during asynchronous revalidation, and guards against late completion after disposal or a newer refresh. Plugin extension refresh revalidates unchanged configs too, so restored artifacts can recover a cached invalid verdict. A trust-file observer propagates changes to other workspace gateways; direct UI mutations await refresh in their own gateway. Started operations may finish.

Fresh verification: hooks 38 tests passed; Desktop 182 tests passed; production build passed; full repository typecheck passed. Independent review found a restored-artifact cached-verdict bug; a regression reproduced it and passed after the fix. The same-agent grant/revoke test verifies no Agent replacement, and altered artifacts are rejected. Gateway full suite passed 76 tests, recorded in desktop-audit/hooks-gateway-tests.log outside the repo; reachability gate also passed. Whole-project test-suite status remains the previously documented CLI timing failure, not a newly claimed green verify:all.

Remaining Agent settings work: direct MCP, skills/commands management and hook configuration editing; the trust/live-refresh portion is now implemented. Visual QA and packaging remain pending.

## User screenshot follow-up: nested timeline disclosures

The user showed ZCode's collapsed and expanded conversation activity: an outer exploration group, independently expandable child tools with invocation/output, and collapsible reasoning. Inspected actual ZCode v4/conversationAssistantWorkItems.ts and its ToolSummaryRow source. Existing Desktop had single-tool output expansion and reasoning details, but lacked the outer grouping and discarded tool arguments in projection.

Added presentation-only grouping of consecutive known exploration, terminal and file-change tools, bounded to one turn and interrupted by readable messages/reasoning. Group identity follows the first call. Tool arguments are retained and shown separately from output, with serialization deferred until expansion. Expansion and group pagination are hoisted above virtual rows; child rendering is paginated at 50 to keep long groups bounded. Backend-provided reasoning remains expandable; no inferred reasoning or fabricated elapsed time is added.

Verified stable identity during streamed group growth, nested expansion, virtual unmount/remount, and page-two restoration. Independent review found local pagination state was lost on virtual unmount; regression failed and then passed after hoisting it. Desktop full suite passed 185 tests before the extra pagination case; final targeted projection/group/disclosure tests and typecheck passed after all fixes. Build passed for the disclosure/pagination integration. Final live visual parity, whole-turn work-stage collapse, richer file/diff navigation and portable packaging are not claimed by this batch.

## Work-stage and file navigation follow-up

Added a turn-bound work-stage disclosure from actual turn/start and turn/end events. Intermediate work can be collapsed while the user prompt, ended turn's last substantive durable assistant reply, and outcome warnings remain visible. Children remain flat virtual rows. No historical elapsed duration is fabricated. Manual expansion or group paging suspends auto-follow so opening details does not pull the reader to the bottom; the existing latest-content button resumes it.

Explicit read/write/edit file arguments can open the existing workspace Review preview. The renderer converts known in-workspace targets to relative paths and rejects external/traversing/URL targets; the existing backend remains the filesystem and symlink authority. Shell commands and patch text are not parsed to guess paths. This is preview routing, not an editor or a new filesystem capability.

Verification: Desktop full suite passed 190 tests before the added auto-follow regression; that regression reproduced an unwanted scroll and passed after the fix along with all other timeline follow/disclosure tests. Typecheck and build passed. Independent review found no actionable issue in stage projection or file routing. Final live visual QA remains pending. Remaining file UX includes richer patch/diff links and attachment/context input flows.
