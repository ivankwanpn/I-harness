# Re-audit report: 6 findings vs OFFICIAL upstream dsh `0.1.0-rc.5`

Date: 2026-08-16 · Investigator: read-only research agent

## Trees audited

| Tree | Path | Identity |
|---|---|---|
| **OFFICIAL (audited)** | `D:\agent-complete\deepseek-harness\deepseek-harness-master` | `@deepseek-ai/dsh-root` `0.1.0-rc.5` (`package.json:2-3`), pristine upstream |
| MODIFIED (NOT audited) | `D:\agent-complete\deepseek-harness-master` | `0.1.0-rc.5` + our anchored-standard/guard changes (tool-bootstrap, bootstrapTools, destructive-command gates, tool-fs approval, terminal-bash resolve) |

**Method:** full-tree greps (`tool-bootstrap|bootstrapTools|bootstrap_tools` → zero hits in OFFICIAL; `DESTRUCTIVE_COMMAND_RE` → zero hits in OFFICIAL) plus direct reads of every cited file in the OFFICIAL tree.

---

## F04-1 (was **Critical**): "On Windows the shipped profile has no bash tool and no persistent shell — the bootstrap anchor silently degrades to the full catalog"

### Official-tree verification
- **`bootstrapTools`/`tool-bootstrap` do NOT exist in the OFFICIAL tree.** Full-tree grep returned no files.
- `packages/guard/` in OFFICIAL contains only `timeout-policy` and `repeat-tool-reminder`, plus READMEs. No `tool-bootstrap` package.
- OFFICIAL standard preset `apps/cli/config/agent-presets/standard/agent.cordis.yml` has **no bootstrap row, no `bootstrapTools` config, and no `persistent-shell` group at all**. Shell rows are explicit platform conditionals:
  - `:44-46` — `tool-bash` / `disabled: !!js process.platform === 'win32'` (line 46)
  - `:48-50` — `tool-pwsh` / `disabled: !!js process.platform !== 'win32'` (line 50)
- OFFICIAL base bundle `packages/bundle/base/cordis.patch.yml` mirrors the split: `bash-sandbox` `:178-180`, `pwsh-sandbox` `:184-186`, `tool-bash` `:210-212`, `tool-pwsh` `:214-216`, plus approval/permission rows `:188-206`.
- OFFICIAL standard preset is the shipped default (`packages/bundle/web-app/cordis.patch.yml:421-424`, `default: standard`).
- OFFICIAL `minimal` preset DOES carry the PTY persistent shell (`apps/cli/config/agent-presets/minimal/agent.cordis.yml:18-45`) **with no platform conditional** — but on Windows the PTY spawn path throws hard: `packages/subprocess/subprocess-local/src/process-inspector.ts:366-373` (`createProcessInspector` → `throw new Error('subprocess-local: terminal inspection is unsupported on platform win32')`), invoked at spawn time in `packages/subprocess/subprocess-local/src/index.ts:174`.

### Corrected finding
**Not applicable as written — withdrawn as a Critical risk; reframed as an informational platform note.**

The finding described *our* modification: on Windows our standard preset disables the minimal persistent-shell (`bootstrapTools: [bash, str_replace_editor]` cannot all resolve) and `tool-bootstrap/src/index.ts:141-152` fail-opens to the full catalog. Upstream, there is **no bootstrap anchor and no narrowing on any platform**: the standard preset exposes the full catalog from request #1 on all platforms by design. The "silent degrade" never happens because the full catalog *is* the always-on state; Windows merely swaps the shell dialect via explicit `process.platform` conditionals.

One genuine, low-severity OFFICIAL observation survives: the OFFICIAL `minimal` preset mounts `persistent-shell` unconditionally, so on Windows the PTY spawn fails loudly at first use (subprocess-local `:174` + `:373`) rather than silently degrading — a platform-gap in the minimal preset, fail-loud, not a silent-degrade vulnerability.

### Impact note
Disposition-table change: **F04-1 Critical removed** (describes a component that does not exist upstream). Optionally replace with a Low/informational platform note about the minimal preset's Windows PTY failure.

---

## F03-2 (was **rewrite**): "bash destructive-command consent gate is a raw-string regex — shell quoting executes `rm` without the approval ask"

### Official-tree verification
- **`DESTRUCTIVE_COMMAND_RE` does not exist in the OFFICIAL tree** (full-tree grep: zero hits). In the MODIFIED tree it is at `packages/shell/tool-bash/src/index.ts:39` with the `tools/pre-execute` listener at `:406-412` — that is our code.
- OFFICIAL `packages/shell/tool-bash/src/index.ts` has **no command-content consent gate and no `tools/pre-execute` listener**. Its only approval path is **sandbox-mode escalation**: `approveBashEscalation` at `:213-228`, `approveEscalation` (from `@deepseek-ai/dsh-sandbox`) at `:23` and `:223`, invoked from `execute` at `:334-335` for the `sandbox_permissions` + `justification` pair (`:65-67` `validateEscalationArgs`).
- Denial and approval are **file-access based, not command-pattern based**: OFFICIAL `packages/shell/bash-sandbox/README.md:19` (denials are result facts via bwrap EROFS / Landlock EACCES / Seatbelt EPERM signatures), `:25` ("Deny-only at the seam … the approval question lives in the tool layer (`dsh-tool-bash`), which drives the override"), `:88` ("`danger-full-access` deliberately bypasses `ctx.sandbox`").
- Approval policy matrix in OFFICIAL `base/cordis.patch.yml:193-206` sets `ask` for read-only/workspace-write and **`never` for `danger-full-access`** (`:205`), with `approval` policy at `:188-192`.
- The official code itself acknowledges the gap: `packages/shell/tool-bash/src/index.ts:6-8` — `TODO(permissions): deployment policy belongs in tools/pre-execute and sandboxing executors`. The `tools/pre-execute` allow/deny/ask gate exists as an extension point (OFFICIAL `packages/core/tools/README.md:5,25,57`) but official `tool-bash` registers nothing on it.

### Corrected finding
**Withdrawn as written (the regex gate is our addition, not upstream). Replaced by a design-level observation about OFFICIAL behavior, severity Low (informational).**

Official dsh performs **no pre-execution approval on destructive commands at all.** A `rm -rf` inside the workspace executes un-gated in the default `workspace-write` mode; an approval ask is only reachable as a *post-denial escalation* (`sandbox_permissions`+`justification` → `ctx.approval`, `tool-bash/index.ts:213-228,334-335`), and under `danger-full-access` (approval `never`, base patch `:205`) there is no human gate on any command. This is an explicit design stance (TODO at `:6-8`), not a defect.

### Impact note
Disposition-table change: **F03-2's specific vulnerability withdrawn**; the "rewrite" disposition drops, replaced by a Low design observation.

---

## F03-8 (was **reuse**): "Presentational anchored bootstrap with honest degrade"

### Official-tree verification
- **`packages/guard/tool-bootstrap` does not exist in the OFFICIAL tree.** OFFICIAL `packages/guard/` contains exactly two sub-packages (`timeout-policy`, `repeat-tool-reminder`) and the family README.
- The entire mechanism (first-request catalog narrow, promotion on durable call, fail-open with `warnOnce`) is our modification.

### Corrected finding
**Withdrawn — the component does not exist upstream.** No official counterpart to "anchored bootstrap" or its "honest degrade"; no such concept exists in official dsh.

### Impact note
Disposition-table change: **F03-8 reuse entry removed** (−1 reuse).

---

## F02-8 (was **reuse**): "Loop-hygiene guard plugins (repeat-tool-reminder, timeout-policy, tool-bootstrap)"

### Official-tree verification
- **`repeat-tool-reminder` and `timeout-policy` exist in OFFICIAL.** Re-anchored evidence:
  - `packages/guard/repeat-tool-reminder/src/index.ts` — `ctx.on('tools/post-execute', …)` at **`:213-227`**; `observe()` at `:189-204`; `ctx.on('agent/pre-step', …)` chain-reset at **`:229-232`**; `GENTLE_REMINDER` at `:63-67`; `detailedReminder` at `:70-78`; `canonicalize` at `:111-114`; `wildcardToRegExp` at `:117-122`; `previewArguments` at `:125-131`; `validateThresholds` at `:134-142`. Original cite `:213-233` re-anchors to `:213-232`.
  - `packages/guard/timeout-policy/src/index.ts` — `ctx.on('tools/execute', …)` at **`:56-77`**; `toolTimeoutResult` at `:41-47`; `TOOL_TIMEOUT` at `:25`; deadline swap/restore of `exec.signal` at `:61-74`. Original cite `:55-78` re-anchors to `:56-77`.
  - Official mount points: `packages/bundle/base/cordis.patch.yml:343-344` (`timeout-policy`) and `:390-391` (`repeat-tool-reminder`).
- **`tool-bootstrap` portion does not exist** — the cite must be dropped.

### Corrected finding
**Holds in modified form.** Official dsh ships exactly two loop-hygiene guard plugins, both present in the base profile:
1. `repeat-tool-reminder` — advisory per-agent consecutive-repeat detector on `tools/post-execute` (`:213-227`), injecting reminders as `additionalContexts`; never vetoes; reset on any user message via `agent/pre-step` (`:229-232`).
2. `timeout-policy` — cooperative per-call deadline enforcer wrapping `tools/execute` (`:56-77`), honoring a tool's declared `timeoutMs`, mapping expiry to structured `TOOL_TIMEOUT` (`:25`, `:41-47`) without leaking the aborted signal into post-execute (`:61-74`).

The "tool-bootstrap" member is our addition and is removed.

### Impact note
Disposition-table change: **F02-8 count unchanged** (still "reuse/holds"), evidence trimmed to the two official packages.

---

## F03-7 (partially affected): "Catalog completeness gate"

### Official-tree verification
- The OFFICIAL completeness gate lives in **`scripts/gen-tool-catalog.ts`**:
  - `assertManifestComplete` at **`:581-590`** — `globSync('packages/*/tool-*')` at `:582`, throws listing any on-disk `tool-*` package absent from `TOOL_PACKAGES` (`:585-589`).
  - `assertToolsHarvested` at **`:599-612`** — throws when a listed package boots zero tools.
  - `TOOL_PACKAGES` manifest at **`:184`**.
  - `--check` freshness mode at **`:719-724`**; guarantee statement at `:694`; `verify-tool-catalog` wired into `doc-sync` at `scripts/run-gates.ts:588`.
- The cited `packages/guard/tool-bootstrap/src/index.ts:142-153` **does not exist upstream** — that portion is dropped.

### Corrected finding
**Holds with re-anchored evidence.** Official catalog-completeness gate is entirely in `scripts/gen-tool-catalog.ts`: coverage gate `assertManifestComplete` (`:581-590`, glob `:582`); harvest gate `assertToolsHarvested` (`:599-612`); freshness gate `--check` (`:719-724`), enforced by `verify-tool-catalog` in `doc-sync` (`scripts/run-gates.ts:588`).

### Impact note
Disposition-table change: **F03-7 count unchanged** (still holds); evidence re-anchored.

---

## F04-5 (line-drift): "Windows-first pwsh resolution & ConstrainedLanguage"

### Official-tree verification
- OFFICIAL `packages/shell/tool-pwsh/src/index.ts` contains the ConstrainedLanguage and named-pipe EPERM contracts verbatim:
  - rationale comment **`:117-123`**; ConstrainedLanguage sentence **`:124-127`**; named-pipe EPERM contract **`:128-133`**; escalation plumbing: `escalationModes` `:199`, `approvePwshEscalation` **`:222-242`**, call site **`:353`**, `validateEscalationArgs` `:99`.
- Original cites `:129-138,256`: content confirmed but lives at `:124-133` (contract) and `:222-242`/`:353` (approval).

### Corrected finding
**Holds; line numbers re-anchored.** Official `tool-pwsh` documents the Windows restricted-token contracts: read-only ⇒ ConstrainedLanguage (`:124-127`); both confined modes ⇒ named-pipe capture fails with EPERM (`:128-133`); escalation via `approvePwshEscalation` (`:222-242`, call `:353`). Cited range moves to `:117-133` + `:199,222-242,353`.

### Impact note
Disposition-table change: **F04-5 count unchanged** (still holds); cited range corrected.

---

## Disposition-table impact summary

| Finding | Was | After re-audit vs OFFICIAL | Count change |
|---|---|---|---|
| **F04-1** | Critical | **Withdrawn** — bootstrap concept/`tool-bootstrap` don't exist upstream; replaced by Low/informational platform note | **−1 Critical** |
| **F03-2** | rewrite | **Withdrawn as written** (regex gate is our code); replaced by Low design observation | "rewrite" disposition drops |
| **F03-8** | reuse | **Withdrawn** — component doesn't exist upstream | **−1 reuse** |
| **F02-8** | reuse | **Holds** (re-anchored); tool-bootstrap member dropped | unchanged |
| **F03-7** | partially affected | **Holds** (re-anchored to gen-tool-catalog.ts) | unchanged |
| **F04-5** | line-drift | **Holds** (re-anchored to tool-pwsh) | unchanged |

**Net effect:** three findings describe mechanisms that exist **only in the modified copy** (F04-1, F03-2, F03-8) and must not be counted against official dsh; three survive against official dsh with re-anchored evidence (F02-8, F03-7, F04-5).

**Files inspected (all OFFICIAL tree unless noted):** `apps/cli/config/agent-presets/standard/agent.cordis.yml`, `apps/cli/config/agent-presets/minimal/agent.cordis.yml`, `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml`, `packages/bundle/headless/cordis.patch.yml`, `packages/shell/tool-bash/src/index.ts`, `packages/shell/tool-pwsh/src/index.ts`, `packages/shell/bash-sandbox/src/index.ts` + `README.md`, `packages/core/tools/README.md`, `packages/subprocess/subprocess-local/src/index.ts`, `packages/subprocess/subprocess-local/src/process-inspector.ts`, `packages/guard/README.md`, `packages/guard/repeat-tool-reminder/src/index.ts`, `packages/guard/timeout-policy/src/index.ts`, `scripts/gen-tool-catalog.ts`, `scripts/run-gates.ts`, `docs/tool-catalog.md`.

**Caveats:** (1) line numbers verified statically via grep/read, not executed; (2) the F04-1 informational note about the minimal preset on Windows is based on the PTY inspector's hard `throw` at spawn — phrase as "fails loud at first spawn" not "fails at load."
