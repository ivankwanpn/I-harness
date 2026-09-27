# Desktop subagent role editor dialog QA

## Change

The role model editor previously expanded inline above the role list, pushing most rows below the first screen. It now opens a compact, centered dialog styled with the existing Desktop tokens. The same provider directory, model choices, English reasoning-effort values, hidden legacy protocol handling and backend `desktop/subagents/mutate` command remain in use. No protocol picker was added.

The dialog begins at the first editable field, traps Tab inside, closes on Escape, and returns focus to its trigger. A failed save and its retry stay visible inside the dialog; an in-flight save disables closing. The settings page is inert while the dialog is open, and its previous state is restored on close.

## Verification

- `pnpm --filter @i-harness/desktop test`: 66 test files, **290 passed**. `pnpm --filter @i-harness/desktop typecheck`: exit 0.
- `pnpm --filter @i-harness/desktop dist`: portable Electron exe/ZIP built. ZIP SHA-256: `26A93145F84CE5A43E5ED94BB178347B3E7757645C2414AFD04167D8C3A6EE99`.
- Packaged Electron at 1280px and 900px: one accessible modal, no horizontal overflow, initial provider focus, Tab wrapping, Escape dismissal and focus return. Existing configured `deepseek / deepseek-flash` and `max` were selected in the form and confirmed to enable Save; Escape closed it **without saving**. No model prompt or filesystem operation was sent.
- Screenshot references: `D:\frontend-research\desktop-role-editor-before-2026-09-28.png`, `D:\frontend-research\desktop-role-editor-after-2026-09-28.png`, `D:\frontend-research\desktop-role-editor-after-900-2026-09-28.png`, `D:\frontend-research\desktop-role-editor-deepseek-2026-09-28.png`.
- An independent read-only review found no Critical or Important issue in focus, keyboard, lifecycle, save/retry or responsive layout. The native select focus outline remained visible and usable.

The user's `packages/desktop/electron.vite.config.ts` edit remains unstaged; no GitHub push occurred.
