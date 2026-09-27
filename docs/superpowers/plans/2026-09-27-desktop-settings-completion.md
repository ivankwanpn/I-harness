# Desktop settings and interface completion

User steering: interface completeness and settings are the priority. Earlier integration delivered backend-connected surfaces but did not finish the settings product. Provider account usage/reset/OAuth remain excluded. Continue autonomously; use existing packages before creating new responsibilities. No GitHub push or edits to D:/I-harness-main.

Latest scope correction: defer keyboard-shortcut settings and data/statistics pages. Do not build Agent browser-control settings without existing backend support. Source inventory finds only Desktop's human-operated WebContentsView surface and its IPC, with no built-in Agent browser-control implementation in packages/apps. Keep that distinction; no new browser automation backend this round. Prioritize visual polish and Agent settings adapted to actual I-harness package contracts, not ZCode's runtime assumptions.

## Current evidence
SettingsPane currently has only general/workspace/about, a150px inner navigation, and provider/session management mixed into workspace. ZCode live Electron at its existing localhost:5174 was launched and inspected through Playwright Electron; real settings replace the workspace sidebar, use grouped icon navigation and a consistent main content column. Screenshot saved outside repo under zcode-research/settings-models-live-2026-09-27.png. This is a reference-app inspection, not a workaround for the previously denied localhost:5173 page.

## Work order and acceptance
- [x] Full-window settings layout replacing workspace navigation, grouped/searchable section navigation, remembered section and narrow layout. Reuse existing Apache-attributed presentation pieces and real reference dimensions. Implemented; final visual comparison remains pending under the final verification item.
- [ ] Split working controls into General, Appearance, Notifications, Models/providers, Memory, Plugins and Workspace/session pages; use coherent page headings, descriptions, card spacing and states.
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
