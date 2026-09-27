import { foldGoal, type GoalView } from "@i-harness/goal"
import { deriveTodoList } from "@i-harness/todo"
import type { TodoItem } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"

export interface DesktopWorkStateView {
  todos: TodoItem[] | null
  goal: GoalView | null
}

/** Session events are the only owner of Todo and Goal state. A cold read must
 * scan the full saved log, not the Desktop's bounded visible history window. */
export function createDesktopWorkState(coordinator: SessionCoordinator, service: SessionService) {
  return {
    async read(sessionId: string): Promise<DesktopWorkStateView> {
      await coordinator.profile(sessionId)
      const session = service.liveSession(sessionId) ?? (await coordinator.load(sessionId)).session
      return { todos: deriveTodoList(session), goal: foldGoal(session.events) }
    },
  }
}
