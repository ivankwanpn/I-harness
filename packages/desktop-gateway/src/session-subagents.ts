export type { TaskResultPage as DesktopSubagentResultPage } from "@i-harness/subagent"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { createSubagentChanges } from "./subagents/changes.ts"
import { createSubagentScope } from "./subagents/scope.ts"
import { createSubagentCatalog } from "./subagents/catalog.ts"
import { createSubagentReader } from "./subagents/read.ts"
import { createSubagentControls } from "./subagents/control.ts"
import type { SubagentReadOptions } from './subagents/types.ts'
export type { DesktopSubagentStatus, DesktopSubagentRow, DesktopSubagentCatalog, DesktopSubagentControl, DesktopSubagentControlResult } from "./subagents/types.ts"

/** Existing read/control owners, composed without creating child work on reads. */
export function createDesktopSubagents(coordinator: SessionCoordinator, service: SessionService, options: SubagentReadOptions & { onChanged?: (parentSessionId: string) => void } = {}) {
  const changes = createSubagentChanges(service, options)
  const scope = createSubagentScope(coordinator, service, changes.open)
  const catalog = createSubagentCatalog(coordinator, service, scope)
  const reader = createSubagentReader(scope, coordinator, options)
  const controls = createSubagentControls(coordinator, service, scope, changes.changed)
  return { ...catalog, ...reader, control: controls.control, async close() { changes.close(); await controls.close() } }
}
