# Desktop custom provider creation dialog QA

## Delivered

- **新增提供商** opens a focused settings dialog rather than expanding a full-width form above the provider directory. The provider ID, display name, API URL and protocol remain visible; optional models URL, card catalog and API-key environment variable are under **進階設定**. The title and help text describe creation, while model addition and existing-provider editing retain their own labels.
- The renderer still sends the existing `provider/create` command through the same Desktop gateway and provider runtime; there is no alternate credential or model path. A failed save keeps typed fields and the error visible. In-flight writes cannot dismiss the modal. Successful creation refreshes the directory and selects the new ID.
- The role dialog's focus/keyboard behavior was extracted into `SettingsDialog` and remained verified. A reviewer found that an unconfigured built-in provider's first override uses a backend `provider/create` command but is visually **editing** an existing provider. Presentation now keys on whether a provider row was passed, while the write action retains its existing configured-override rule. The dialog's focusable set also includes an advanced-section summary during a pending save.

## Verification

- Red-green focused tests covered title/copy, advanced disclosure, modal dismissal/focus, saved selection, failed and pending writes, and built-in first-override presentation. After review fixes, the full Desktop suite reported **66 files / 297 tests passed** and Desktop typecheck exited 0.
- `pnpm --filter @i-harness/desktop dist` built the unsigned portable application. ZIP SHA-256: `CB073C47002BAEBBF5DFC5A170E8B59FFAC7710E580A5A3DFF8AE7099FD4A5E3`.
- Packaged Electron at 1280px and 900px showed the focused add dialog, initial provider-ID focus, folded/expandable advanced fields, Escape dismissal and focus return; document scroll width matched the window width. Screenshots: `D:\frontend-research\desktop-provider-add-after-1280-2026-09-28.png`, `D:\frontend-research\desktop-provider-add-after-900-2026-09-28.png`.
- In the real `D:\agent-complete\playground` workspace, a unique temporary provider with a `.invalid` URL and no key/model was created through the UI, immediately selected, then removed through the two-step confirmation. The provider directory ID list matched its original value afterward. No provider probe, model call or credential write was made. The QA script has a direct cleanup fallback for a failed run; this run completed its UI removal path.
- The current playground directory has one configured route and no unconfigured built-in row to inspect visually. That presentation was verified with a focused renderer test, not claimed as packaged visual evidence. An independent reviewer found no other Important issue; its two findings above were fixed and retested.

The user's `packages/desktop/electron.vite.config.ts` edit remained unstaged. No GitHub push or edit to `D:\I-harness-main` occurred. Provider account usage/reset/OAuth remains deferred.
