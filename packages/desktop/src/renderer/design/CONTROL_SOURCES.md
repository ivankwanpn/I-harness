# Shared Desktop controls and dialogs

The controls in `controls.css`, `vendor/opencode/Button.tsx`,
`settings/SettingsDialog.tsx`, and `useModalLayer.ts` adapt the following MIT
sources. Their copyright and permission notices are retained in
`LICENSE.controls.txt`. Reference source directories are read only.

## OpenCode

Version: 1.18.30, local source root `D:/agent-complete/opencode-1.18.30`.
The product reference audit also verified the relevant V2 tree against official
1.18.35. Paths below are relative to the source root; hashes are SHA-256 of the
inspected local files.

| Source path | SHA-256 |
| --- | --- |
| `packages/ui/src/v2/components/button-v2.tsx` | `305a7b3c7864590234d5d8fc6f39dc94d37f8d74e893e786995e1834477f739a` |
| `packages/ui/src/v2/components/button-v2.css` | `fab590f850ea90cb807fa4d7c97dce28a9cdcb0419f729b58cd64e52dad1e468` |
| `packages/ui/src/v2/components/text-input-v2.css` | `ac9aefdb0ea0a77ea40b01c95ad8072a4857b67fc3d2cec1383cf4a9e4746db5` |
| `packages/ui/src/v2/components/dialog-v2.tsx` | `68b743ca3243fbb1dcb8a218e2e5fea439ca76bb6184d3d779eb6d0465fb7b3d` |
| `packages/ui/src/v2/components/dialog-v2.css` | `10245157047c44d168d54be20edd8aba365d86b2d138fd870bee50eec14e1f42` |

Adapted treatments: a compact inline button frame; neutral, contrast, danger,
pressed and focus states; tabular numeric fields; field borders and invalid,
disabled and focused states; a named dialog header with an explicit close
action and a scrollable body.

IH uses React and native buttons. The existing primary/secondary/ghost API,
native disabled safety, system typography, Lucide glyphs and `--ih-*` theme
variables are retained. Loading is an explicit boolean with `disabled` and
`aria-busy`, rather than an upstream CSS-only variant. Sizes have comfortable
minimum heights and grow with the user's font preference. The upstream global
reset, fixed-height dialog and Solid/Kobalte runtime are not included.

## DeepSeek Harness (DSH)

Version: 0.2.0-rc.2, local source root
`D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2`.

| Source path | SHA-256 |
| --- | --- |
| `packages/client/ui-primitives/src/useModalLayer.ts` | `c584a5cde081548fadaedbf703c205915e924a7b67a0488d45b56cfe960718e4` |
| `packages/client/ui-primitives/src/keyboard-composition.ts` | `be1684e7f3b8306da3cb991f1a5e393065d74107892b78a1002cdf2624f23f6c` |
| `packages/client/ui-primitives/src/Modal.tsx` | `f4f2ee9eb84c88b92ecd8419a24621ca422a0f8a71f0bd247947002d342e078f` |
| `packages/client/ui-primitives/src/Modal.module.css` | `c9d511821e0d13e6f1eb0e69642abb7740acf8a77aece12ad7906713076db24f` |
| `packages/client/ui-primitives/src/settings-form/fields.tsx` | `E0ED4DF493F212D22FAA4BE63C1E74E1DBFF37688D581BA120AC07CCA9D2F267` |
| `packages/client/ui-primitives/src/settings-form/SettingsForm.tsx` | `BFBC1DBB9C718480EEDF914CCDED57686304726ED6971C65B317CF3B79D8CDEE` |
| `packages/client/ui-primitives/src/settings-form/form-model.ts` | `2DCD07C849ABCD0B26D9C1855C9870A1DD1231CE58EF9A6D767BA092608EE81B` |

Adapted behavior: foreground modal ownership of document Escape and Tab;
respect for nested menus and prevented events; composition lifetime including
the late closing keydown and legacy IME key code 229; entry and return focus;
and a body-portaled responsive dialog with a named close button.
`foreground-escape.ts` applies the same composition and foreground dismissal
policy to IH model, context, permission and conversation action popovers.

IH adds reference-counted background inert state, inert lower dialog layers,
busy dismissal blocking, focus filtering for hidden ancestors, disabled
fieldsets and collapsed details, and a return-focus chain when overlapping
dialogs unmount out of order. Automatic focus preserves scroll position and
retains the product's keyboard focus indicators.

The pre-existing ZCode adapters remain separately attributed under Apache-2.0.
This shared-control task copied no new ZCode source.

The DSH form sources were inspected during the field audit. The product now
exposes only the two native Context switches; its numeric quota and reference
editor prototypes are not included in the Desktop renderer.
