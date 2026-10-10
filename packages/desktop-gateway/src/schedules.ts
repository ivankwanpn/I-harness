import { foldScheduleEvents, scheduleView } from "@i-harness/schedule"
import { createScheduleTools, type ScheduleCreateArgs, type ScheduleCreateOutput } from "@i-harness/schedule/tools"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"

/** The UI manages the selected conversation's existing schedule log. No clock
 * or background worker is started here; the assembly's driver still checks
 * due rules only at Agent step boundaries. */
export function createDesktopSchedules(coordinator: SessionCoordinator, service: SessionService) {
  const idle = (sessionId: string): void => {
    const queue = service.queueState(sessionId)
    if (queue.running || queue.queued > 0) throw new Error("session is busy")
  }

  return {
    async list(sessionId: string) {
      await coordinator.profile(sessionId)
      let session = service.liveSession(sessionId)
      if (!session) {
        if (!coordinator.snapshot) throw new Error("Read-only schedule snapshots unavailable")
        const saved = (await coordinator.snapshot(sessionId)).session
        session = service.liveSession(sessionId) ?? saved
      }
      const folded = foldScheduleEvents(session.events, session.header?.seedLength ?? 0)
      const now = Date.now()
      return { schedules: folded.active.map((record) => scheduleView(record, now)) }
    },
    async create(sessionId: string, command: ScheduleCreateArgs): Promise<ScheduleCreateOutput> {
      await coordinator.profile(sessionId)
      idle(sessionId)
      const assembly = await service.assemblyFor(sessionId)
      idle(sessionId)
      const tool = createScheduleTools({ session: assembly.session }).find((entry) => entry.name === "schedule_create")!
      const result = await tool.execute(command, {}) as ScheduleCreateOutput
      await coordinator.flush(sessionId)
      return result
    },
    async delete(sessionId: string, id: string): Promise<{ deleted: string }> {
      await coordinator.profile(sessionId)
      idle(sessionId)
      const assembly = await service.assemblyFor(sessionId)
      idle(sessionId)
      const tool = createScheduleTools({ session: assembly.session }).find((entry) => entry.name === "schedule_delete")!
      const result = await tool.execute({ id }, {}) as { deleted: string }
      await coordinator.flush(sessionId)
      return result
    },
  }
}
