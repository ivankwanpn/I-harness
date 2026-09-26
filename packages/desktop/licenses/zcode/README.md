# ZCode UI attribution

Portions of the permission-card UI are adapted from ZCode 3.14.0 under Apache-2.0. These portions retain that license; I-harness code retains its existing license.

Upstream snapshot: D:/agent-complete/ZCode-main, source archive without Git metadata.
Source: packages/ui/src/PermissionDialog.tsx, SHA256 402DA6E509554A0DFFDA982EB2C2D20809629EE98FCD47677029B9BB5E6F37E9.
Theme: packages/ui/src/styles.css, Codex dark values.

Adapted files: src/renderer/vendor/zcode/PermissionCard.tsx and styles.css.
Additional adapted file: src/renderer/vendor/zcode/ComposerSurface.tsx from packages/ui/src/prompt-editor/ChatPromptEditor.tsx, SHA256 A560C7B3711FC2B0DACD036D205313BF5FE91FB09389082110E9F118FA18D96C. Retains form/surface/toolbar markup and classes; replaces Lexical and service-backed menus with React slots connected to existing I-harness drafts and sends. Model label uses existing session/model/state and is read-only.
Modifications (2026-09-26): extract JSX layout and utility classes, replace services/providers/stores with props, use native radio controls and explicit confirmation, preserve visible focus, omit global resets. No brand assets copied.

Additional extractions: ToolSummaryRow.tsx derives summary layout and classes from ToolCallBlocks/ToolSummaryRow.tsx, replacing Radix triggering with a native button. LightweightDiffPreview.tsx derives row layout and addition/removal tint styles from components/ui/lightweight-diff-preview.tsx; it consumes raw unified diff, distinguishes headers from hunk content, preserves protocol markers and omits synthetic line numbers, syntax-highlighter and settings-store dependencies. Lazy tool output handling remains in the I-harness adapter.

Source SHA256:
Additional extraction: ReviewFileRow.tsx adapts the file header in GitPaneChangeCard.tsx. It replaces ZCode file descriptors and numeric change counts with I-harness path/status props, and omits context-menu mutations and unsupported filesystem actions.
GitPaneChangeCard.tsx SHA256: EC300EC0D682BB3E6E7A23F5C888550C4FBA0C8711CAD5A66A61FE28AD6F0088.
- ToolCallBlocks/ToolSummaryRow.tsx: 81A0C2F954A73B81FF4ED113D56A3FB6B594D66E3A8358C910A2A25CEF922715
- components/ui/lightweight-diff-preview.tsx: 7D1FF2A02815D988F5FFD2D6549848920C98488A4DBA43F67BA9D81A3DA49D01

LICENSE and UPSTREAM-NOTICE.md are preserved verbatim. The upstream notice describes ZCode, not I-harness. No ZCode runtime, provider, remote service or telemetry implementation is included in this extraction.
