import { TaskResultOwner } from "./task/result.ts"
import { createHash } from "node:crypto"
import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./tools/types.ts"

export interface ReportPolicy { childPreviewBytes: number; maxReportBytes: number }
export const SHIPPING_REPORT_POLICY: Readonly<ReportPolicy> = Object.freeze({ childPreviewBytes: 2048, maxReportBytes: 16384 })
export interface ReportPageArgs { cursor?: string; offset_bytes?: number; max_output_bytes?: number; digest?: string; field?: string; body?: boolean; result_revision?: string; ref_revision?: string; ref_id?: string }
export const reportPageSchema = {
  body: { type: 'boolean', description: 'Read the exact retained encoded JSON child terminal body. data contains JSON fragments, not decoded resultText/error.' },
  result_revision: { type: 'string', description: 'Original child result revision; rejects changed results.' },
  ref_revision: { type: 'string', description: 'Original immutable artifact revision.' },
  ref_id: { type: 'string', description: 'Original immutable artifact identity.' },
  cursor: { type: "string", description: "Stateless next_cursor from the same report generation." },
  offset_bytes: { type: "integer", minimum: 0, description: "UTF8 byte offset for one owned result." },
  max_output_bytes: { type: "integer", minimum: 1024, description: "Final JSON page byte budget, capped by the report policy." },
  digest: { type: "string", description: "Result digest from the previous page; rejects changed results." },
  field: { type: "string", enum: ["resultText", "finalText", "text", "error"], description: "Result field to page (default result text, or error if no text)." },
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")
export const reportDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex")

function prefix(text: string, budget: number): string {
  const b = Buffer.from(text, "utf8")
  let end = Math.min(budget, b.length)
  while (end > 0 && end < b.length && (b[end]! & 0xc0) === 0x80) end--
  return b.subarray(0, end).toString("utf8")
}

export function boundedNotification(render: (text: string, description: string) => string, text: string, description: string, reference: string, policy: ReportPolicy): string {
  const summary = prefix(description, policy.childPreviewBytes)
  let budget = policy.childPreviewBytes
  for (;;) {
    const preview = prefix(text, budget)
    const output = render(`${preview}\n[Full result: ${reference}]`, summary)
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= policy.maxReportBytes) return output
    if (budget === 0) throw new Error("Report metadata exceeds notification budget")
    budget = Math.floor(budget / 2)
  }
}

/** Pure projection over the existing owned result. No cursor allocates authority or storage. */
export function boundReport(output: Record<string, unknown>, args: ReportPageArgs, policy: ReportPolicy, reference: (row: Record<string, unknown>, field: string, digest: string) => Record<string, unknown> | undefined): Record<string, unknown> {
  if (!Number.isSafeInteger(policy.maxReportBytes) || policy.maxReportBytes < 1024 || !Number.isSafeInteger(policy.childPreviewBytes) || policy.childPreviewBytes < 4) throw new Error("Invalid report policy")
  if (args.max_output_bytes !== undefined && (!Number.isSafeInteger(args.max_output_bytes) || args.max_output_bytes < 1024)) throw new Error("max_output_bytes must be an integer >= 1024")
  const cap = Math.min(args.max_output_bytes ?? policy.maxReportBytes, policy.maxReportBytes)
  const key = ["agents", "tasks", "jobs"].find(k => Array.isArray(output[k]))
  const rows = key ? output[key] as Record<string, unknown>[] : [output]
  const generation = reportDigest(rows.map(({ elapsed_ms: _elapsed, ...row }) => row))
  let start = 0
  if (args.cursor) {
    let cursor: { digest: string; offset: number }
    try { cursor = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")) } catch { throw new Error("Invalid report cursor") }
    if (cursor.digest !== generation) throw new Error("Report digest changed; restart pagination")
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= rows.length) throw new Error("Invalid report cursor offset")
    start = cursor.offset
  }
  const paging = args.offset_bytes !== undefined || args.digest !== undefined || args.field !== undefined
  if (paging && rows.length !== 1) throw new Error("Result paging requires exactly one owned result")
  const projected: Record<string, unknown>[] = []
  const envelope = (end: number): Record<string, unknown> => ({
    ...(key ? Object.fromEntries(Object.entries(output).filter(([k]) => k !== key)) : {}),
    ...(key ? { [key]: projected } : projected[0]),
    ...(key && projected.some(row => row.truncated) ? { truncated: true } : {}),
    ...(end < rows.length ? { truncated: true, next_cursor: Buffer.from(JSON.stringify({ digest: generation, offset: end })).toString("base64url") } : {}),
  })
  for (let i = start; i < rows.length; i++) {
    const raw = rows[i]!, row = { ...raw }
    const fields = ["resultText", "finalText", "error", "text"].filter(f => typeof raw[f] === "string")
    const selected = args.field ?? fields.find(f => f !== "error") ?? "error"
    const digest = raw.result_revision !== undefined ? reportDigest({ revision: raw.result_revision, ref: raw.result_ref }) : reportDigest(raw[selected])
    if (args.digest !== undefined && args.digest !== digest) throw new Error("Result digest changed; restart pagination")
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "string" && !fields.includes(k) && !/^(id|path|agent_path|task_id|job_id|session_id|sessionId|jobId|status|outcome)$/.test(k)) {
        row[k] = prefix(v, policy.childPreviewBytes)
        if (row[k] !== v) row.metadata_truncated = true
      }
    }
    if (fields.length) {
      row.digest = digest
      const ref = reference(raw, selected, digest)
      if (ref) row.full_result = { ...ref, digest }
      if (args.field !== undefined && !fields.includes(args.field)) throw new Error("Unknown result field")
      const slices: { field: string; text: string; offset: number; total: number; budget: number }[] = []
      for (const field of fields) {
        const text = raw[field] as string, b = Buffer.from(text, "utf8")
        const offset = field === selected ? args.offset_bytes ?? 0 : 0
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > b.length || (offset < b.length && (b[offset]! & 0xc0) === 0x80)) throw new Error("offset_bytes must be a UTF8 boundary within the result")
        slices.push({ field, text: b.subarray(offset).toString("utf8"), offset, total: b.length, budget: paging && field === selected ? cap : Math.floor(policy.childPreviewBytes / fields.length) })
        if (field !== selected) {
          const fieldRef = reference(raw, field, reportDigest(raw[field]))
          if (fieldRef) row[`${field}_full_result`] = fieldRef
        }
      }
      const assemble = () => {
        for (const slice of slices) {
          row[slice.field] = prefix(slice.text, slice.budget)
          while ((!paging || slice.field !== selected) && bytes(row[slice.field]) > policy.childPreviewBytes / fields.length && slice.budget > 0) {
            slice.budget = Math.floor(slice.budget / 2)
            row[slice.field] = prefix(slice.text, slice.budget)
          }
          if (slice.field === selected) {
            row.offset_bytes = slice.offset; row.total_bytes = slice.total
            row.next_offset_bytes = slice.offset + Buffer.byteLength(row[slice.field] as string, "utf8")
            row.truncated = row.next_offset_bytes !== slice.total
          }
        }
      }
      assemble()
      projected.push(row)
      // Aggregate pagination keeps complete row previews on later pages rather
      // than squeezing a final row to an empty preview in a nearly full page.
      if (!projected.slice(0, -1).length || paging) {
        while (bytes(envelope(i + 1)) > cap && slices.some(slice => slice.budget > 0)) {
          for (const slice of slices) slice.budget = Math.floor(slice.budget / 2)
          assemble()
        }
      }
      projected.pop()
      if (paging && row.truncated && row.next_offset_bytes === row.offset_bytes) throw new Error("Report metadata leaves no room for result page")
    }
    projected.push(row)
    if (bytes(envelope(i + 1)) > cap) {
      projected.pop()
      if (!projected.length) throw new Error("Report metadata exceeds byte budget")
      return envelope(i)
    }
  }
  return envelope(rows.length)
}

export function withReportPolicy(tool: Tool, deps: SubagentToolDeps): Tool {
  if (!deps.reportPolicy || !["list_agents", "wait_agent", "get_task_output", "job_output", "job_list", "spawn_agent"].includes(tool.name)) return tool
  const reference = (row: Record<string, unknown>, field: string, digest: string) => {
    const taskId = row.task_id
    if (typeof taskId === "string") {
      const task = deps.tasks.get(taskId)
      if (task?.result) return { tool: 'get_task_output', args: { task_ids: [taskId], body: true, result_revision: task.result.revision, ...(task.result.kind === 'retained' && task.result.envelope.retention.kind === 'artifact' ? { ref_revision: task.result.envelope.retention.ref.revision, ref_id: task.result.envelope.retention.ref.id } : {}), offset_bytes: 0 }, retention: task.result.kind === 'pending' ? 'pending' : task.result.envelope.retention.kind }
      return { tool: "get_task_output", args: { task_ids: [taskId], field, digest, offset_bytes: 0 }, retention: task?.retention ?? "memory", ...(task?.retentionError ? { retention_error: prefix(task.retentionError, 256) } : {}) }
    }
    const job = row.job_id ?? row.jobId
    if (typeof job === "string" && row.result_revision) return { tool: "job_output", args: { job_id: job, body: true, result_revision: row.result_revision, ...(row.result_ref ? { ref_revision: (row.result_ref as any).revision, ref_id: (row.result_ref as any).id } : {}), offset_bytes: 0 }, retention: row.result_retention }
    return typeof job === "string" ? { tool: "job_output", args: { job_id: job, digest, offset_bytes: 0 }, retention: row.retention ?? "memory" } : undefined
  }
  return { ...tool, get description() { return tool.description }, get inputSchema() {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> }
    return { ...schema, properties: { ...schema.properties, ...reportPageSchema } }
  }, execute: async (args, exec) => {
    const output = await tool.execute(args, exec) as Record<string, unknown>, pageArgs = args as ReportPageArgs
    const rows = output.tasks as Record<string, unknown>[] | undefined
    if (tool.name === 'get_task_output' && rows?.length === 1) {
      const row = rows[0]!, taskId = row.task_id as string, task = deps.tasks.get(taskId)!
      if (task.result) {
        const digest = reportDigest({ revision: task.result.revision, ref: row.result_ref })
        const full_result = reference(row, '', digest)
        if (pageArgs.field !== undefined) return { error: { code: 'unsupported-selector', message: 'Retained child bodies use complete encoded JSON pages; field selectors apply only to historical raw records.' }, full_result }
        if (pageArgs.body || pageArgs.offset_bytes !== undefined || pageArgs.digest !== undefined) {
          if (pageArgs.digest !== undefined && pageArgs.digest !== digest) throw new Error('Result digest changed; restart pagination')
          const cap = Math.min(pageArgs.max_output_bytes ?? deps.reportPolicy!.maxReportBytes, deps.reportPolicy!.maxReportBytes)
          return deps.tasks.readResult(taskId, { offset: pageArgs.offset_bytes, maxBytes: cap, revision: pageArgs.result_revision, refRevision: pageArgs.ref_revision, refId: pageArgs.ref_id })
        }
      }
    }
    if (tool.name === "job_output" && output.result_revision) {
      const full_result = reference(output, "", "")
      if (pageArgs.field !== undefined) return { error: { code: "unsupported-selector", message: "Retained child bodies use complete encoded JSON pages; field selectors apply only to historical raw records." }, full_result }
      if (pageArgs.body || pageArgs.offset_bytes !== undefined || pageArgs.digest !== undefined) {
        if (!deps.results) throw new Error("Retained job body reader unavailable")
        const job = deps.jobs.read(output.job_id as string)
        const digest = reportDigest({ revision: output.result_revision, ref: output.result_ref })
        if (pageArgs.digest !== undefined && pageArgs.digest !== digest) throw new Error("Result digest changed; restart pagination")
        return new TaskResultOwner(deps.results).read({ id: job.id, parentSessionId: job.owner, result: job.result }, { offset: pageArgs.offset_bytes, maxBytes: Math.min(pageArgs.max_output_bytes ?? deps.reportPolicy!.maxReportBytes, deps.reportPolicy!.maxReportBytes), revision: pageArgs.result_revision, refRevision: pageArgs.ref_revision, refId: pageArgs.ref_id })
      }
    }
    return boundReport(output, pageArgs, deps.reportPolicy!, reference)
  } }
}
