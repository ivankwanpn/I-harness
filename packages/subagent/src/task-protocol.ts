import { createHash } from "node:crypto"
import type { SessionCoordinator } from "@i-harness/session-persistence"

export type TaskStatus = "accepted" | "running" | "completed" | "error" | "cancelled" | "recovery-required"
export type TaskOutcome = "completed" | "error" | "cancelled" | "recovery-required"
export type TaskDelivery = "tool" | "parent"
export type RecoveryReason = "dispatch-unknown" | "response-interrupted"
export type OutboxStatus = "pending" | "delivered" | "woken" | "error" | "suppressed"

export interface TaskIdentity { parentSessionId: string; callEventSeq?: number; toolCallId?: string }
export interface TaskRecord {
  id: string
  parentSessionId: string
  toolCallId?: string
  callEventSeq?: number
  childSessionId?: string
  agentPath: string
  description: string
  prompt: string
  agent: string
  delivery: TaskDelivery
  status: TaskStatus
  outcome?: TaskOutcome
  resultText?: string
  error?: string
  recoveryReason?: RecoveryReason
  timeCreated: number
  timeStarted?: number
  timeCompleted?: number
}
export interface TaskNotificationRecord {
  id: string
  submissionId: string
  parentSessionId: string
  messageId: string
  state: TaskOutcome
  description: string
  text: string
  status: OutboxStatus
  attempts: number
  timeCreated: number
  timeDelivered?: number
  timeWoken?: number
  error?: string
}
export interface TaskProtocolDocument { formatVersion: 1; tasks: TaskRecord[]; notifications: TaskNotificationRecord[] }

export function taskDocKey(stateId: string): string {
  // ADAPTATION (M26-D1, plan §Storage "key: task:<stateId>"): a colon makes
  // the jsonl backend's doc filename `task:sess-<id>.doc.jsonl` an NTFS
  // alternate data stream — writeFile succeeds, rename dies EINVAL (observed
  // in the win32 CLI suite). Dash keeps it a plain filename and still namespaces
  // clear of session ids (`sess-*`). Sqlite stores the key verbatim either way.
  return `task-${stateId}`
}

export function notificationMessageId(taskId: string): string {
  return `msg_task_${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`
}

export class TaskIdentityConflictError extends Error {
  constructor(readonly identity: TaskIdentity) {
    super(`task identity conflict: ${identity.parentSessionId}:${identity.callEventSeq ?? identity.toolCallId ?? "anon"}`)
    this.name = "TaskIdentityConflictError"
  }
}
export class TaskConcurrencyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`subagent concurrency limit reached (max ${limit})`)
    this.name = "TaskConcurrencyLimitError"
  }
}

export interface TaskSubmissionInput {
  identity: TaskIdentity
  childSessionId?: string
  agentPath: string
  description: string
  prompt: string
  agent: string
  delivery: TaskDelivery
}
export interface TaskTerminalizeInput {
  taskId: string
  outcome: TaskOutcome
  resultText?: string
  error?: string
  recoveryReason?: RecoveryReason
}
export interface TaskRegistryOptions {
  coordinator?: SessionCoordinator
  stateId?: string
  maxConcurrency?: number
  onTerminalized?: (task: TaskRecord) => void
}
export interface TaskRegistry {
  submit(input: TaskSubmissionInput): TaskRecord
  get(taskId: string): TaskRecord | undefined
  getByIdentity(identity: TaskIdentity): TaskRecord | undefined
  getByChildSession(childSessionId: string): TaskRecord | undefined
  list(): TaskRecord[]
  notifications(): TaskNotificationRecord[]
  updateNotification(id: string, patch: Partial<Omit<TaskNotificationRecord, "id" | "submissionId">>): boolean
  claim(taskId: string, childSessionId?: string): boolean
  terminalize(input: TaskTerminalizeInput): boolean
  cancelTree(taskId: string, error?: string): { taskIds: string[]; cancelled: number }
  runningCount(): number
  wait(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined>
  restore(doc: TaskProtocolDocument): void
  save(): Promise<void>
}

export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  const records = new Map<string, TaskRecord>()
  const byIdentity = new Map<string, TaskRecord>()
  const byChild = new Map<string, TaskRecord>()
  const notifs: TaskNotificationRecord[] = []
  const maxConcurrency = opts.maxConcurrency ?? Infinity
  // Ruling M24a-T1a 同款：restore 時以已知最大編號 seed counter（M26-D1）
  let taskCounter = 0
  let notifCounter = 0
  let anonCounter = 0
  let saveChain: Promise<void> = Promise.resolve()

  function identityKey(identity: TaskIdentity): string {
    if (identity.callEventSeq !== undefined) return `${identity.parentSessionId}:${identity.callEventSeq}`
    if (identity.toolCallId !== undefined) return `${identity.parentSessionId}:call:${identity.toolCallId}`
    anonCounter += 1
    return `anon:${anonCounter}` // 每次全新 → 永不 adopt；identity-less 提交的逃逸規則
  }

  function matches(existing: TaskRecord, input: TaskSubmissionInput): boolean {
    return (
      existing.prompt === input.prompt &&
      existing.agent === input.agent &&
      existing.agentPath === input.agentPath &&
      existing.delivery === input.delivery
    )
  }

  function snapshot(): TaskProtocolDocument {
    return { formatVersion: 1, tasks: [...records.values()], notifications: [...notifs] }
  }

  function save(): Promise<void> {
    if (!opts.coordinator || !opts.stateId) return Promise.resolve()
    const p = saveChain.then(() => opts.coordinator!.putDocument(taskDocKey(opts.stateId!), snapshot()))
    saveChain = p.catch(() => {}) // M6: report, never reject
    return p
  }

  function enqueueNotification(task: TaskRecord): void {
    if (task.delivery !== "parent" || task.outcome === undefined) return
    notifCounter += 1
    const text = task.outcome === "completed"
      ? task.resultText ?? ""
      : task.error ?? task.resultText ?? ""
    notifs.push({
      id: `notif-${notifCounter}`,
      submissionId: task.id,
      parentSessionId: task.parentSessionId,
      messageId: notificationMessageId(task.id),
      state: task.outcome,
      description: task.description,
      text,
      status: "pending",
      attempts: 0,
      timeCreated: Date.now(),
    })
  }

  function terminalize(input: TaskTerminalizeInput): boolean {
    const t = records.get(input.taskId)
    if (!t || t.outcome !== undefined) return false // CAS: only non-terminal settles
    t.status = input.outcome
    t.outcome = input.outcome
    if (input.resultText !== undefined) t.resultText = input.resultText
    if (input.error !== undefined) t.error = input.error
    if (input.recoveryReason !== undefined) t.recoveryReason = input.recoveryReason
    t.timeCompleted = Date.now()
    enqueueNotification(t)
    void save()
    opts.onTerminalized?.(t)
    return true
  }

  return {
    submit(input) {
      // R-D3 配額：running(非終態) 計數 >= max → fail-closed
      if (runningCountUnsafe() >= maxConcurrency) throw new TaskConcurrencyLimitError(maxConcurrency)
      const key = identityKey(input.identity)
      const existing = byIdentity.get(key)
      if (existing) {
        if (matches(existing, input)) return existing // exact retry → adopt
        throw new TaskIdentityConflictError(input.identity)
      }
      taskCounter += 1
      const record: TaskRecord = {
        id: `task-${taskCounter}`,
        parentSessionId: input.identity.parentSessionId,
        ...(input.identity.toolCallId !== undefined ? { toolCallId: input.identity.toolCallId } : {}),
        ...(input.identity.callEventSeq !== undefined ? { callEventSeq: input.identity.callEventSeq } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
        agentPath: input.agentPath,
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        delivery: input.delivery,
        status: "accepted",
        timeCreated: Date.now(),
      }
      records.set(record.id, record)
      byIdentity.set(key, record)
      if (record.childSessionId) byChild.set(record.childSessionId, record)
      void save()
      return record
    },
    get: (taskId) => records.get(taskId),
    getByIdentity(identity) { return byIdentity.get(identityKey(identity)) },
    getByChildSession: (childSessionId) => byChild.get(childSessionId),
    list: () => [...records.values()],
    notifications: () => [...notifs],
    updateNotification(id, patch) {
      const n = notifs.find((x) => x.id === id)
      if (!n) return false
      Object.assign(n, patch)
      void save()
      return true
    },
    claim(taskId, childSessionId) {
      const t = records.get(taskId)
      if (!t || t.status !== "accepted") return false
      t.status = "running"
      t.timeStarted = Date.now()
      if (childSessionId !== undefined && t.childSessionId === undefined) {
        t.childSessionId = childSessionId
        byChild.set(childSessionId, t)
      }
      void save()
      return true
    },
    terminalize,
    cancelTree(taskId, error = "task cancelled by owner") {
      const root = records.get(taskId)
      if (!root) return { taskIds: [], cancelled: 0 }
      const tree = [root, ...[...records.values()].filter((r) => r.agentPath.startsWith(`${root.agentPath}/`))]
      const taskIds: string[] = []
      let cancelled = 0
      for (const t of tree) {
        if (t.outcome !== undefined) continue
        t.status = "cancelled"
        t.outcome = "cancelled"
        t.error = error
        t.timeCompleted = Date.now()
        enqueueNotification(t)
        taskIds.push(t.id)
        cancelled += 1
      }
      if (cancelled > 0) void save()
      return { taskIds, cancelled }
    },
    runningCount: runningCountUnsafe,
    async wait(taskId, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const t = records.get(taskId)
        if (!t || t.outcome !== undefined) return t
        if (Date.now() >= deadline) return t
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    restore(doc) {
      // Counter seeding（Ruling M24a-T1a 同款）：還原的 id 是權威——task-<n> /
      // notif-<n> 從已知最大編號續增，避免 post-restore spawn 撞 id。
      for (const t of doc.tasks) {
        const m = /^task-(\d+)$/.exec(t.id)
        if (m) taskCounter = Math.max(taskCounter, Number(m[1]))
      }
      for (const n of doc.notifications) {
        notifs.push(n)
        const m = /^notif-(\d+)$/.exec(n.id)
        if (m) notifCounter = Math.max(notifCounter, Number(m[1]))
      }
      // anonymous 還原記錄用獨立命名空間（restored-anon:N），永不與新
      // anonymous submit 的 anon:<n> 相撞——anonymous 任務永不 adopt（Task 3 規約）。
      let restoredAnon = 0
      for (const t of doc.tasks) {
        if (records.has(t.id)) throw new Error(`duplicate task id on restore: ${t.id}`)
        records.set(t.id, t)
        const anon = t.callEventSeq === undefined && t.toolCallId === undefined
        if (anon) restoredAnon += 1
        byIdentity.set(
          t.callEventSeq !== undefined
            ? `${t.parentSessionId}:${t.callEventSeq}`
            : t.toolCallId !== undefined
              ? `${t.parentSessionId}:call:${t.toolCallId}`
              : `restored-anon:${restoredAnon}`,
          t,
        )
        if (t.childSessionId) byChild.set(t.childSessionId, t)
      }
    },
    save,
  }

  function runningCountUnsafe(): number {
    let n = 0
    for (const t of records.values()) if (t.status === "accepted" || t.status === "running") n += 1
    return n
  }
}

export async function classifyRestoredTasks(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<number> {
  let classified = 0
  for (const t of tasks.list()) {
    if (t.outcome !== undefined) continue
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
