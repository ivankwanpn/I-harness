# Desktop terminal and provider selection visual QA — 2026-09-28

The general settings page now separates the terminal choice from window reset controls. The interface-language row names its purpose and explains the setting. The selected provider in **模型與提供商** has a visible inset outline matching the ZCode reference's selected-list treatment. These changes use existing controls and do not change shell execution behavior.

The rebuilt portable Electron app was opened against `D:\agent-complete\playground` at 900px and 1280px. Both general-settings screenshots show the **終端** section and the saved Auto shell selection. The gateway now returns the resolved executable with each detected shell profile, and the general page reports Auto's actual `C:\Program Files\Git\bin\bash.exe`; an older gateway that omits this field simply shows no path. Both provider screenshots show the selected DeepSeek row with a computed 2px inset outline. In all four views, document scroll width equaled window width and no alert was present. The terminal pane also names each live session with its executable basename and stable terminal ID; a packaged playground run displayed `bash.exe · term-1` for the detected Git Bash process, then closed that PTY.

- `D:\frontend-research\desktop-terminal-general-900-2026-09-28.png`
- `D:\frontend-research\desktop-terminal-general-1280-2026-09-28.png`
- `D:\frontend-research\desktop-provider-selected-900-2026-09-28.png`
- `D:\frontend-research\desktop-provider-selected-1280-2026-09-28.png`
- `D:\frontend-research\desktop-terminal-tab-label-900-2026-09-28.png`
- `D:\frontend-research\desktop-terminal-tab-label-1280-2026-09-28.png`

The targeted gateway-terminal, native-UI, settings-UI and terminal-UI suites passed (15/15), and the Desktop and gateway package typechecks passed. The settings and terminal-UI suites now reset their language state before each test; without this, a prior English-language test could make Chinese accessible-name lookups fail. The earlier real CMD and Git Bash workspace checks remain documented in `2026-09-28-desktop-reminders-terminal-qa.md`.
