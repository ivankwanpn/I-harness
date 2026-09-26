# ZCode UI attribution

Portions of the permission-card UI are adapted from ZCode 3.14.0 under Apache-2.0. These portions retain that license; I-harness code retains its existing license.

Upstream snapshot: D:/agent-complete/ZCode-main, source archive without Git metadata.
Source: packages/ui/src/PermissionDialog.tsx, SHA256 402DA6E509554A0DFFDA982EB2C2D20809629EE98FCD47677029B9BB5E6F37E9.
Theme: packages/ui/src/styles.css, Codex dark values.

Adapted files: src/renderer/vendor/zcode/PermissionCard.tsx and styles.css.
Additional adapted file: src/renderer/vendor/zcode/ComposerSurface.tsx from packages/ui/src/prompt-editor/ChatPromptEditor.tsx, SHA256 A560C7B3711FC2B0DACD036D205313BF5FE91FB09389082110E9F118FA18D96C. Retains form/surface/toolbar markup and classes; replaces Lexical and service-backed menus with React slots connected to existing I-harness drafts and sends. Model label uses existing session/model/state and is read-only.
Modifications (2026-09-26): extract JSX layout and utility classes, replace services/providers/stores with props, use native radio controls and explicit confirmation, preserve visible focus, omit global resets. No brand assets copied.

LICENSE and UPSTREAM-NOTICE.md are preserved verbatim. The upstream notice describes ZCode, not I-harness. No ZCode runtime, provider, remote service or telemetry implementation is included in this extraction.
