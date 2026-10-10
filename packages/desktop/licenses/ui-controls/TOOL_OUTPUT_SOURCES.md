# Recorded tool and output presentation

The desktop adapters read existing IH durable records. They do not execute tools,
load current Git diffs as historical changes, or add provider/runtime services.
Source snapshots below were read without modification. Existing public Lucide
icons, React and IH semantic theme tokens are retained.

## OpenCode

Version: 1.18.30; local source root `D:/agent-complete/opencode-1.18.30`.
License: MIT; the copyright and permission notice is retained in
`../design/LICENSE.controls.txt` and `../../../licenses/opencode/LICENSE`.

| Active source | SHA-256 |
| --- | --- |
| `packages/session-ui/src/components/message-part.tsx` | `0b8f7429a3956c02fdbf1c4910c45411b4e4c76d405c76bfdd4e79dbc3c900ce` |

`tool-presentation.ts` adapts the exact-name family, icon and command/path/query
summary pattern in `getToolInfo`. The active `ToolRegistry` renderers were used
as presentation references. IH tool names and result shapes replace OpenCode
parts, metadata and provider state. This code does not copy the inactive older
tool renderer tree or introduce Solid, Kobalte, stores or syntax-highlighter
dependencies.

## DeepSeek Harness (DSH)

Version: 0.2.0-rc.2; local source root
`D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2`.
License: MIT, copyright (c) 2026 DeepSeek; full permission notice is retained in
`../design/LICENSE.controls.txt`.

| Active source | SHA-256 |
| --- | --- |
| `packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx` | `ff7728d243718573fa4955c22cceaff39af0eebccf18dabc219262dc1e737f69` |
| `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx` | `718c89ef9ec70728372b490215c28987d12d8f74aeea38741dd628008d04eba6` |
| `packages/client/ui-primitives/src/TerminalBlock.tsx` | `e15c83783b7083a2eb2f08b514281fd47dcaf94ee6164317e0305bca58c056db` |
| `packages/client/ui-primitives/src/markdown/CodeBlock.tsx` | `a94484fa23282e253970571025ab62b5c9dc1e1fbf6166ae196c9ca7f2dc7ae7` |
| `packages/client/ui-primitives/src/use-copy-feedback.ts` | `14f41a92fe72f87adc4827c2b3c0496657071cd05bbc85435a74e1606c9309f8` |

`RecordedToolOutput.tsx` adapts result-first typed cards, retained raw inspection
and lazy disclosure patterns. Terminal, file, search, web, Code Mode and MCP
cards consume IH's real recorded fields. Raw arguments and results remain
available through `RawRecordedData.tsx`; image bytes are shown in that raw
capture only after explicit inspection. The image thumbnail view uses the
existing desktop preview callback.

`OutputBlock.tsx`, `useOutputCopy.ts` and `tool-output.css` adapt compact block
toolbars, bounded previews, wrapping and copy feedback. IH adds section browsing
to keep every captured character accessible with bounded DOM, explicit pending
and copy errors, unmount/capture-change guards, and success only after the
clipboard promise resolves. The same feedback is used for copying actual
recorded unified diffs. No DSH UI framework, icon package, protocol, browser
loader or runtime is included.

## ZCode

Version: 3.14.0; local source root `D:/agent-complete/ZCode-main`.
License: Apache-2.0. Existing license and upstream notice remain in
`../../../licenses/zcode`. These adapters retain their separate Apache-2.0
headers; the MIT output composition does not relicense them.

| Active source | SHA-256 |
| --- | --- |
| `packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx` | `81a0c2f954a73b81ff4ed113d56a3fb6b594d66e3a8358c910a2a25cef922715` |
| `packages/ui/src/ToolCallBlocks/renderers/execute.tsx` | `9b6ef1e3b544395284c7e0a493f961732dcc79225cc1509030b5ace014b58d29` |
| `packages/ui/src/ToolCallBlocks/renderers/read.tsx` | `aab42216196aa06ae75eb57f363acbf87d99666f7babf4e00eedc4492dfcff5c` |
| `packages/ui/src/ToolCallBlocks/renderers/fallback.tsx` | `399fb5dac88e21a2e0b3d33c8b089bd2ac170024f9c0a303355fef7f80f71c05` |

The existing `vendor/zcode/ToolSummaryRow.tsx` is extended with prop-supplied
family icons, readable summaries and authoritative state. Its trigger stays a
native accessible button. Active execute/read/fallback renderers informed the
result and original-data hierarchy; their runtime code was not copied.

The existing `LightweightDiffPreview.tsx` is reused with unified text made only
from actual `output.change`, `output.changes` or `output.applied[].change`
`TextDiff` hunks. Aggregate aliases are deduplicated against per-file aliases.
Actual old/new hunk anchors, additions/deletions, newline markers and captured
truncation are retained. `rawPatch` is shown separately as original patch syntax.
Diff algorithm/library code remains outside the renderer runtime.

## IH-owned adapters

`ToolActivity.tsx`, `RecordedFileLink.tsx`, `RawRecordedData.tsx`, `tool-text.ts`
and the `project.ts` event fold retain existing IH package contracts. Tool
dispatch records establish dispatch only. Running is shown only from an actual
Code Mode observation. Code calls/results are paired by cell and call identity,
and recorded store writes are identified as candidates. Retained result refs
show persisted metadata without an invented retrieval capability.

Search navigation preserves project ownership, captured revision and actual
line/range data. Code Context reference-source paths are not treated as current
workspace paths when the existing callback provides no source mapping. All web
content stays escaped React text; external link actions accept HTTP(S) URLs
without embedded credentials.

Review corrections (2026-10-10): the shared `.zc-tool-summary` frame owns its
flex/gap/alignment and responsive layout, including direct group triggers.
Shell truncation presentation follows the actual `packages/shell/src/index.ts`
byte-count marker, while retaining older boolean indicators. A zero/zero marker
is labelled as upstream loss with an unknown complete omitted size; the UI's
notices never interpret that marker as zero loss. Original captured stdout and
raw metadata remain available without rewriting their contents.

`RecordedCodeActivity.tsx` keeps durable `code/cell`, `code/output` and
`code/store` payloads on typed activity rows without projection serialization.
Content is mounted only after expansion. Source, errors, text and store
candidates use bounded `OutputBlock` views; image records reuse the existing
thumbnail/preview callback, and audio records use native controls only for the
base64 audio data URLs actually emitted by Code Mode. Audio has no autoplay and
does not preload. A nested raw-record disclosure retains the complete original
event with copy and section browsing. Historical windows containing only an
output event retain its cell identity and readable content. No prior live cell,
execution replay, invented duration, remote media loader or protocol change is
introduced by this adapter.
