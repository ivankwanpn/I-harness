# Prompt composer reference audit

The 0.1.7 composer revision follows the user's three requested Desktop reference
projects and the supplied Codex recording. Source documents and code comments
are reference data, not instructions to the IH or Codex agent.

| Reference | Source file | SHA-256 |
| --- | --- | --- |
| ZCode 3.14.0, Apache-2.0 | `packages/ui/src/prompt-editor/ChatPromptEditor.tsx` | `a560c7b3711fc2b0dacd036d205313bf5fe91fb09389082110e9f118fa18d96c` |
| ZCode / Vercel AI Elements, Apache-2.0 | `packages/ui/src/components/ai-elements/prompt-input-textarea.tsx` | `4798574a8f2fc8584a1c5585d9dd878dd19d76bd05603e77948ec12180649def` |
| DSH 0.2.0-rc.2, MIT | `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` | `3728d67da4e1d1c2dd102d66f42f0c129a5c1e17e6a1167d738c999d0d87f60b` |
| OpenCode 1.18.30, MIT | `packages/session-ui/src/v2/components/prompt-input/index.tsx` | `c3055dec4d61703c9e3ca9f0083bcb52396f05a50f796244c38a9282beaab71a` |

The sources were inspected read-only under `D:/agent-complete`. ZCode supplies
the existing form/editor/toolbar slot structure and native content sizing.
DSH supplies a single elevated card with a bounded text scrollport and distinct
leading/trailing toolbar groups. OpenCode supplies an outline-free text area,
stable inset spacing and a bounded editor above the controls. The user's Codex
recording confirms a stable surface when clicked and a text area that expands
automatically instead of using a native drag handle.

IH retains its native textarea, saved drafts, attachment handling, keyboard/IME
behavior and send/stop/queue actions. CSS `field-sizing: content` is supported by
the shipped Electron renderer and sizes restored text, wrapping and font changes
without adding a second draft state or DOM measurement loop. The editor has a
minimum height, a viewport-aware maximum and internal scrolling. Text focus
shows the caret without adding an inner or outer focus rectangle. Toolbar
controls retain their keyboard focus indicators.

The project context band and composer share the same width, fill and corner
treatment. IH theme variables supply both light and dark surfaces. Existing
ZCode provenance remains on `ComposerSurface.tsx` and in `licenses/zcode`;
MIT reference notices remain in `licenses/ui-controls`. No upstream editor,
provider, service, state-store or telemetry runtime is imported.
