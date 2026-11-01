import { TaskConcurrencyLimitError, TaskIdentityConflictError, type TaskIdentity, type TaskRecord, type TaskSubmissionInput } from './types.ts'

/** Sole live task records, lookup indexes and ID allocation. Cross-owner
 * retention, persistence, outbox and publication stay in the registry. */
export class TaskRecords {
  readonly #records = new Map<string, TaskRecord>()
  readonly #byIdentity = new Map<string, TaskRecord>()
  readonly #byChild = new Map<string, TaskRecord>()
  readonly #originalDelivery = new WeakMap<TaskRecord, TaskRecord['delivery']>()
  protectSubmission(task: TaskRecord, deferBirth = false): void {
    if (this.#originalDelivery.has(task)) return
    this.#originalDelivery.set(task, task.delivery)
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
    }
    if (task.childBirth) freeze(task.childBirth)
    for (const key of ['id','parentSessionId','toolCallId','callEventSeq','agentPath','description','prompt','agent','timeCreated','childBirth'] as const) {
      if (deferBirth && key === 'childBirth') continue
      Object.defineProperty(task, key, { value: task[key], enumerable: Object.hasOwn(task, key), writable: false, configurable: false })
    }
  }
  #taskCounter = 0
  #anonCounter = 0
  #checkedCounter = false

  get(taskId: string): TaskRecord | undefined { return this.#records.get(taskId) }
  has(taskId: string): boolean { return this.#records.has(taskId) }
  values(): IterableIterator<TaskRecord> { return this.#records.values() }
  getByIdentity(identity: TaskIdentity): TaskRecord | undefined { return this.#byIdentity.get(this.#identityKey(identity)) }
  getByChildSession(childSessionId: string): TaskRecord | undefined { return this.#byChild.get(childSessionId) }

  #identityKey(identity: TaskIdentity): string {
    if (identity.callEventSeq !== undefined) return `${identity.parentSessionId}:${identity.callEventSeq}`
    if (identity.toolCallId !== undefined) return `${identity.parentSessionId}:call:${identity.toolCallId}`
    this.#anonCounter += 1
    return `anon:${this.#anonCounter}` // Anonymous lookup also allocates; never adopts.
  }

  submit(input: TaskSubmissionInput, maxConcurrency: number): { record: TaskRecord; inserted: boolean } {
    // Capacity precedes identity adoption, including exact retries.
    if (this.runningCount() >= maxConcurrency) throw new TaskConcurrencyLimitError(maxConcurrency)
    const key = this.#identityKey(input.identity)
    const existing = this.#byIdentity.get(key)
    if (existing) {
      if (existing.prompt === input.prompt && existing.agent === input.agent && existing.agentPath === input.agentPath && (this.#originalDelivery.get(existing) ?? existing.delivery) === input.delivery) return { record: existing, inserted: false }
      throw new TaskIdentityConflictError(input.identity)
    }
    if (this.#checkedCounter && this.#taskCounter >= Number.MAX_SAFE_INTEGER) throw new Error('Task counter exhausted')
    this.#taskCounter += 1
    const record: TaskRecord = {
      id: `task-${this.#taskCounter}`,
      parentSessionId: input.identity.parentSessionId,
      ...(input.identity.toolCallId !== undefined ? { toolCallId: input.identity.toolCallId } : {}),
      ...(input.identity.callEventSeq !== undefined ? { callEventSeq: input.identity.callEventSeq } : {}),
      ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
      agentPath: input.agentPath,
      description: input.description,
      prompt: input.prompt,
      agent: input.agent,
      delivery: input.delivery,
      status: 'accepted',
      timeCreated: Date.now(),
    }
    this.#records.set(record.id, record)
    this.#byIdentity.set(key, record)
    if (record.childSessionId) this.#byChild.set(record.childSessionId, record)
    return { record, inserted: true }
  }

  claim(taskId: string, childSessionId?: string, modelLabel?: string, jobId?: string): TaskRecord | undefined {
    const task = this.#records.get(taskId)
    if (!task || task.status !== 'accepted') return undefined
    task.status = 'running'
    task.timeStarted = Date.now()
    if (modelLabel !== undefined) task.modelLabel = modelLabel
    if (jobId !== undefined) task.jobId = jobId
    if (childSessionId !== undefined && task.childSessionId === undefined) {
      task.childSessionId = childSessionId
      this.#byChild.set(childSessionId, task)
    }
    return task
  }

  runningCount(): number {
    let n = 0
    for (const task of this.#records.values()) if (task.status === 'accepted' || task.status === 'running') n += 1
    return n
  }

  seedRestoredCounter(tasks: readonly TaskRecord[], strict = false): void {
    if (strict) this.#checkedCounter = true
    for (const task of tasks) {
      const match = /^task-(\d+)$/.exec(task.id)
      if (match) { const value = Number(match[1]); if (strict && (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe restored task counter'); this.#taskCounter = Math.max(this.#taskCounter, value) }
    }
  }
  checkRestoredId(taskId: string): void {
    if (this.#records.has(taskId)) throw new Error(`duplicate task id on restore: ${taskId}`)
  }
  insertRestored(task: TaskRecord): void { this.#records.set(task.id, task) }
  indexRestored(task: TaskRecord, restoredAnon: number, strict = false): void {
    const key = task.callEventSeq !== undefined
        ? `${task.parentSessionId}:${task.callEventSeq}`
        : task.toolCallId !== undefined
          ? `${task.parentSessionId}:call:${task.toolCallId}`
          : `restored-anon:${restoredAnon}`
    if (strict && (this.#byIdentity.has(key) || !!task.childSessionId && this.#byChild.has(task.childSessionId))) throw new Error('Duplicate restored task index')
    this.#byIdentity.set(key, task)
    if (task.childSessionId) this.#byChild.set(task.childSessionId, task)
  }
}
