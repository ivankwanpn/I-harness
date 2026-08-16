# DeepSeek Harness Risk Audit

Read-only audit of the OFFICIAL upstream
`D:\agent-complete\deepseek-harness\deepseek-harness-master` (dsh `0.1.0-rc.5`).
Correction note: the initial audit pass ran against a local MODIFIED copy
(`D:\agent-complete\deepseek-harness-master`); findings were re-verified against
the OFFICIAL tree and findings F04-1/F03-2/F03-8 were rewritten as Minor
observations because they described local-only modifications (see
`reaudit-official.md`).
Purpose: produce the disposition table (reuse / rewrite / improved-writing) that
drives the I-harness kernel design (see
`docs/superpowers/specs/2026-08-16-i-harness-runtime-design.md` §2-§4).

## Sections

| # | Area | File | Status |
|---|------|------|--------|
| 01 | Session persistence & format | `findings/01-session-persistence.md` | done |
| 02 | Plugin kernel, scopes, waterfalls, guards | `findings/02-plugin-kernel.md` | done |
| 03 | Tool execution pipeline & safety seams | `findings/03-tool-pipeline.md` | done |
| 04 | Windows execution environment | `findings/04-windows-exec.md` | done |
| 05 | Interaction model & UI consumption | `findings/05-interaction.md` | done |

## Final report

`dsh-risk-audit.md` — consolidated disposition table.

## Disposition values

- **reuse** — audit confirms the component is clean enough to copy as reference.
- **rewrite** — fault found; do not copy.
- **improved-writing** — concept stable but our implementation should write it better; the finding states which bug it avoids.