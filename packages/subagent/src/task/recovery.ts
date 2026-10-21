import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { TaskRegistry } from "./types.ts"
export async function classifyRestoredTasks(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<number> {
  let classified = 0
  for (const t of tasks.list()) {
    if (t.outcome !== undefined || t.publication === 'unqualified') continue
    const evidence = t.childSessionId === undefined
      ? undefined
      : await completedTurnEvidence(coordinator, t.childSessionId)
    if (evidence === undefined || evidence.turnEnd === false) {
      tasks.terminalize({
        taskId: t.id,
        outcome: "recovery-required",
        recoveryReason: evidence === undefined ? "dispatch-unknown" : "response-interrupted",
        error: "process restarted before the attempt settled",
      })
    } else {
      tasks.terminalize({ taskId: t.id, outcome: "completed", resultText: evidence.lastAssistantText })
    }
    classified += 1
  }
  return classified
}

// R-D3: parent 是否落在已取消的 delegation chain 上（task 以 childSessionId
// 連結祖先；1 hop 每層）。用於 outbox suppression。
export function isSessionCancelledChain(tasks: TaskRegistry, sessionId: string): boolean {
  let cur = sessionId
  for (let i = 0; i < 64; i++) {
    const t = tasks.getByChildSession(cur)
    if (!t) return false
    if (t.outcome === "cancelled") return true
    if (t.parentSessionId === "") return false
    cur = t.parentSessionId
  }
  return false
}

async function completedTurnEvidence(
  coordinator: SessionCoordinator,
  sessionId: string,
): Promise<{ turnEnd: boolean; lastAssistantText?: string } | undefined> {
  try {
    const { session } = await coordinator.load(sessionId)
    const seedLength = session.header?.seedLength ?? 0
    const after = session.events.slice(seedLength)
    const turnEnd = after.some((e) => e.type === "turn/end")
    const lastAssistant = after.filter((e) => e.type === "assistant/message").at(-1)
    return {
      turnEnd,
      ...(turnEnd && lastAssistant ? { lastAssistantText: lastAssistant.text } : {}),
    }
  } catch {
    return undefined // log 缺/損 → dispatch-unknown（呼叫端 reclassify）
  }
}
