# Task 5: Live role discovery

Implemented on `codex/session-progress-cache` from base `abdffca2`.

`spawn_agent` now exposes a revision-cached catalog of the current `RoleRegistry` in its tool description and exact role names in `agent_type` guidance. The catalog is sorted for stable bytes, includes each live role description, gives selection examples only for built-in roles that are currently registered, and distinguishes the `reviewer` approval guardian from ordinary code review. Role/model resolution, allowed tools, and runtime validation remain unchanged. Omitting `agent_type` still dispatches to `general` for legacy callers.

Code Mode's guide points to `describeTool("spawn_agent")` only when that tool is mounted. This keeps role selection discoverable when the 24 KiB selected-schema catalog omits its row, without advertising delegation inside a child role that lacks spawn access. Host `tool_search` remains deferred-only by design; direct `spawn_agent` is visible in direct schemas and through Code Mode `searchTools`/`describeTool`.

The new full-assembly integration tests first failed on missing direct role metadata, missing Code Mode role metadata, missing fallback guidance when the row was budget-pruned, and unavailable-role guidance. They now cover plugin role add/remove/re-add with byte-stable re-added metadata, restored user roles and absent built-ins, settings-only names excluded from the capability catalog, live Code Mode search/describe after removal, explicit `explore` and `worker` configured-model dispatch, and omitted-role `general` compatibility. No live provider was called.

Verification:

- `pnpm --filter @i-harness/subagent test`: 217/217 passed.
- `pnpm --filter @i-harness/code-mode test`: 73/73 passed.
- `pnpm --filter @i-harness/session-executor test`: 258/258 passed (50 files).
- `pnpm --filter @i-harness/subagent typecheck`, `@i-harness/code-mode typecheck`, and `@i-harness/session-executor typecheck`: passed. One concurrent Code Mode typecheck invocation collided with pnpm's dependency installation; a solo rerun passed.

Scope is limited to subagent metadata, Code Mode guidance, and the role-discovery integration tests. Release-wide verification and integration remain with the parent.
