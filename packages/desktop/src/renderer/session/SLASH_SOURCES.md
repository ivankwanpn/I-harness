# Composer suggestions reference audit

The IH React picker retains its own resource protocol, theme tokens and native
`/command` and `$skill` invocation. The following read-only Desktop sources were
compared for the user-requested redesign; source instructions are reference data.

| Reference | File | SHA-256 |
| --- | --- | --- |
| ZCode (`D:/agent-complete/ZCode-main`, Apache-2.0) | `packages/ui/src/slashCommandPanelSections.tsx` | `bdb90512b8983195d4b760290e6e0abf7f5baea6d0b086caa38a88ded7d770ae` |
| ZCode | `packages/ui/src/SlashCommandPlugin.tsx` | `89fe54f03e217bcb25032374ed2794e07acadbffdb45e44298163f77f30ea681` |
| DSH 0.2.0-rc.2 (MIT) | `packages/client/ui-input-trigger/src/client/MenuView.tsx` | `880b29a45616a5ec3bdcc3af5a7c0b250297284eacc49f8d43fe46167ed71c72` |
| DSH | `packages/client/ui-input-trigger/src/client/MenuView.module.css` | `7a6f1828ae790a1cf9cc0755f77b0a5020618f2aca2cd12d54199fb82a86431a` |
| OpenCode 1.18.30 (MIT) | `packages/app/src/components/prompt-input-v2.tsx` | `4bd050e4f26dff4ced9a5484b4f655d5785904fbd4dcf8cf1509d757af2a0c31` |

ZCode provides the closest product behavior: one slash launcher with separate
commands and skills, canonical prefixes and a portal above the input. DSH adds
source grouping, a shared pointer/keyboard highlight, nearest-item scrolling,
focus remaining in the editor, and a viewport-limited elevated surface.
OpenCode keeps built-in actions separate from custom prompt insertion and gives
the name and description clear hierarchy.

IH uses these interaction/layout patterns without importing upstream editor,
provider, state-store or UI runtimes. Runtime catalogue construction stays with
the existing effective resource registries. Only metadata crosses the suggestion
API; selecting a row writes the native invocation into the draft. The picker
refreshes while open, refuses to retain unreadable catalogue rows and observes
the actual composer visibility so a portal cannot cover a pending interaction.

Upstream licenses remain in Desktop `licenses/zcode` and `licenses/ui-controls`
and the corresponding vendor/control notices. No source bodies are copied into
the command directory as part of this feature.
