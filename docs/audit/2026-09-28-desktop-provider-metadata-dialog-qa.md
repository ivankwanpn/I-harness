# Desktop provider and model metadata dialog QA

## Change

- The provider card's **編輯提供商**, **新增模型** and model-pencil actions now open the shared focused settings dialog. The provider list and model rows stay in place behind it. New-model focus starts at Model ID; editing an existing model starts at Context Window, following the useful behavior inspected in ZCode's `ProviderModelMetadataDialog` source.
- Context window, maximum output tokens, protocol and input modality remain **model fields**. The existing `ProviderEditor` continues to send its previous `provider/edit` or `model/add|edit` command with only changed overrides. No new provider protocol or credential path was added.
- Review found two Important issues in the first implementation. First, changing URL/protocol could remount a card keyed by those values and detach the focus-return target. Second, the provider card still had a separate inline URL/protocol editor with an independent draft. The inline editor was removed; the card shows current values read-only, edits only through the modal, is keyed by stable provider ID, and the directory retains that ID after save. Tests reproduced both problems before the fix.

## Evidence

- `pnpm --filter @i-harness/desktop test`: **66 files, 300 tests passed** after the review fixes. `pnpm --filter @i-harness/desktop typecheck`: exit 0.
- `pnpm --filter @i-harness/desktop dist`: portable Electron package built. ZIP SHA-256 `836E688D3051EB6529B2A0022002EFCB25329C1A36B12A45A7F8FF77E459C607`.
- Packaged Electron at 1280px and 900px opened the real `deepseek-flash` model editor with context window `1000000` focused, then the Add Model dialog with Model ID focused. Escape closed both and restored focus; the provider directory stayed byte-for-byte equal before and after. Document scroll width matched window width. Screenshots: `D:\frontend-research\desktop-model-editor-after-1280-2026-09-28.png` and `D:\frontend-research\desktop-model-editor-after-900-2026-09-28.png`.
- A unique temporary provider in `D:\agent-complete\playground` was created through the UI without credential or model, then its API URL was edited from a `.invalid/v1` to `.invalid/v2` endpoint. The same provider stayed selected, focus returned to Edit Provider, and the directory reflected the new URL. Two-step UI removal then restored the original provider ID list. No probe or model call occurred. The QA script includes a cleanup fallback and this run completed UI removal.

Only Desktop package tests/typecheck were rerun for this UI-only change; a new full workspace run is still required before claiming the entire long-running goal complete. The user's `packages/desktop/electron.vite.config.ts` change remained unstaged. Nothing was pushed to GitHub.
