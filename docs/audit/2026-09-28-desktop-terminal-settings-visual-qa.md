# Desktop terminal and provider selection visual QA — 2026-09-28

The general settings page now separates the terminal choice from window reset controls. The interface-language row names its purpose and explains the setting. The selected provider in **模型與提供商** has a visible inset outline matching the ZCode reference's selected-list treatment. These changes use existing controls and do not change shell execution behavior.

The rebuilt portable Electron app was opened against `D:\agent-complete\playground` at 900px and 1280px. Both general-settings screenshots show the **終端** section and the saved Auto shell selection. Both provider screenshots show the selected DeepSeek row with a computed 2px inset outline. In all four views, document scroll width equaled window width and no alert was present.

- `D:\frontend-research\desktop-terminal-general-900-2026-09-28.png`
- `D:\frontend-research\desktop-terminal-general-1280-2026-09-28.png`
- `D:\frontend-research\desktop-provider-selected-900-2026-09-28.png`
- `D:\frontend-research\desktop-provider-selected-1280-2026-09-28.png`

The targeted `native-ui` and `settings-ui` suites passed (8/8), and the Desktop package typecheck passed. The settings suite now resets its language state before each test; without this, a prior English-language test could make its Chinese accessible-name lookup fail. The earlier real CMD and Git Bash workspace checks remain documented in `2026-09-28-desktop-reminders-terminal-qa.md`.
