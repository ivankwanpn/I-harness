# Root Task2 visual inspection — 2026-10-20

Product368d18fa; actual-component preview from sealed receipt57 and `preview-dist-sealed/`. Root launched only the supplied loopback static server at127.0.0.1:47832, inspected it in a temporary hidden IAB tab via cua_repl, then closed the tab and stopped the exact helper session81342 with Ctrl+C. Helper exit1 is deliberate teardown, not a product/test failure. Installed IH and user sessions were not opened or changed.

Viewport1265×712, verified from JPEG headers; existing dark IH tokens/CSS, actual ToolActivity→RecordedToolOutput→RecordedResultEnvelope plus real UI locale store. Harness headings/outer scenario boxes are test-only. The five controlled data cases are not claims that the displayed synthetic ref exists in a live store.

Observed:

- Successful inline output containing `error` and `status:'failed'` ordinary data remains “已收到結果” / “Result received”. Output is readable; expanding Raw record shows the original fields/receipt rather than only a preview.
- Failed artifact stays failed and separately says Not dispatched / Output saved / Partial capture · source-limited. It does not promise complete source capture.
- Succeeded/quota refusal stays received and separately says retention unavailable with quota reason.
- Unknown remains explicit “結果未知” / “Unknown result”, separate from not-dispatched/storage status.
- Two native PNG fixture items appear once each in recorded name/order, with metadata showing first and second. These are1px black test PNGs, not broken remote resources.
- Chinese/English controls update actual component labels. The original-record disclosure expands correctly; no model/tool invocation or artifact read is attached to these actions.
- Existing output blocks, typography, spacing and muted/danger states remain within the card layout. No observed page-width overflow or overlapping controls in these captured views.

Evidence under `visual/`: zh-top.jpg, zh-lower.jpg, zh-media.jpg, en-raw.jpg and en-raw.ax.txt. Root captured these from the actual browser UI; files were not image-edited. Cua returned JPEG bytes, initially saved with a `.png` extension; identical-byte `.jpg` copies and header-verified dimensions are recorded in `task-2-visual-manifest-v2.json`. Original files and the invalid PNG-offset metadata attempt are preserved locally, not presented as valid dimension evidence. The initial attempt to scroll AXWebArea index0 failed as a detached accessibility element without altering the page; a fresh screenshot and coordinate scroll succeeded. These are automation/metadata recovery, not application defects.

Limits: static controlled component preview only, not installed app/IPC, native full-size image comparison, light theme or a responsive viewport matrix. Component/renderer/build/runtime tests and independent code review provide separate evidence. No visual defect requiring product changes was identified in this scope.
