# Desktop workflow completion implementation plan

> Execution follows the existing development and verification skills, with independent domains delegated using dispatching-parallel-agents.

**Goal:** Complete the approved Desktop workflow features and audit smaller capabilities including Todo and their user interfaces.

**Architecture:** Keep the session log and existing domain packages authoritative. Transient reasoning updates use the existing event stream, while durable blocks remain canonical. Shell execution uses a selected dialect through a generic command tool. Session workflow controls invoke domain mutations/tools with scope, revision and lifecycle checks. Reviewer reuse stays internal and tool-free; approval history uses a bounded per-session document.

**Constraints:** Work in D:/frontend-test on codex/desktop-workbench, exclude the user's Electron config change, no remote push. Use real configured DeepSeek Anthropic Messages and OpenAI Responses for acceptance. Do not impose turn/goal-round allowances. Old Anthropic test-session migration is excluded. Preserve workspace boundaries, actual approval authority and cancellation.

## Tasks

- [x] Immediate reasoning: core-session/core-agent transient batches, Desktop event-window/project/disclosure, canonical replay/cancellation regression tests, App integration.
- [x] Agent Shell: settings and executable detection, generic shell tool with correct dialect and approval binding, general setting UI, assembly/gateway wiring, real harmless command acceptance.
- [x] Reviewer reuse/history: bounded internal contexts keyed by model/protocol/policy/permissions, fresh verdict per action, rollback on failure, per-session durable history, inspection UI.
- [x] Durable jobs: enable job/status producer, project full cold log/doc, show last saved state separately from actual live cancellability, scoped output inspection.
- [x] Team: mount real roster/task tools per session, preserve lead identity, support multiple Desktop sessions without global singleton collision, roster/task board UI and lifecycle tests.
- [x] Goal: create/edit/pause/resume/complete/clear using existing domain CAS, active-objective prompt and completion tool, explicit start/continue control with cancellation and no round allowance.
- [x] Plan Mode: durable per-session control, dynamic planning prompt and tool admission enforcement, UI switch, restore tests.
- [x] Fine capability inventory: verify backend producer, read/control API, UI, persistence and tests for Todo, queue, questions/approval, reminders, tools, review/rewind, context, skills, MCP/plugins, models and workflow controls.
- [x] Integrate, review, run final complete verification gate, repair distribution module isolation/manifest resolution, package, perform actual two-protocol DeepSeek/tool/reasoning and Desktop UI acceptance, save audit and deliver.

## Ownership and acceptance

Reasoning, shell and guardian packages are delegated independently; root owns shared gateway host/router/types, session assembly integrations, Desktop request/IPC/Workbench integration and workflow controller. Each domain runs meaningful failing-then-passing tests. Final acceptance must distinguish actual provider tests from local wire fixtures, cold history from live authority, and product behavior from the mere presence of a backend package.
