// The creation surface (spec §6.2): three session-scoped tools. The MODEL supplies a rule; the
// engine allocates the id (allocateScheduleId — never reuses), so `schedule_delete` only ever
// speaks `schedule-<n>`. create/delete are deliberately NOT concurrency-safe: both fold-then-append,
// and two parallel creates would allocate the SAME id against the same fold — the scheduler
// serializes non-safe tools for exactly this shape (todo_write can be safe because it REPLACES).
//
// Every read and write touches ONLY this session's own suffix (§5, the forked-session rule): a
// child session that inherited its parent's prefix (header.seedLength) owns neither the parent's
// records nor their ids — the same slice task-protocol.ts:355 applies to a forked log.
import { append, type Session, type SessionEvent } from "@i-harness/core-session"
import type { Tool } from "@i-harness/core-tools"
import {
  ScheduleInputError,
  allocateScheduleId,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  foldScheduleEvents,
  scheduleView,
  type ScheduleRecord,
  type ScheduleView,
} from "./index.ts"

export interface ScheduleToolDeps { session: Session }

function ownEvents(session: Session): readonly SessionEvent[] {
  return session.events.slice(session.header?.seedLength ?? 0)
}

export interface ScheduleCreateArgs { prompt: string; after_seconds?: number; at?: string; every_seconds?: number }
export interface ScheduleCreateOutput { id: string; kind: "after" | "at" | "every"; scheduledAt: string }

function createScheduleCreateTool(deps: ScheduleToolDeps): Tool<ScheduleCreateArgs, ScheduleCreateOutput> {
  return {
    name: "schedule_create",
    description: "create a session-local reminder; exactly ONE of after_seconds (delay), at (RFC 3339 with an explicit Z or numeric offset), every_seconds (fixed rate, minimum 300) must be provided; the reminder fires while this session is live",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        after_seconds: { type: "number", minimum: 1 },
        at: { type: "string" },
        every_seconds: { type: "number", minimum: 1 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    execute: async (args) => {
      // The schema dialect has no `oneOf`, so "exactly one selector" can only be checked here —
      // before anything is folded or written.
      const selectors = [args.after_seconds !== undefined, args.at !== undefined, args.every_seconds !== undefined]
        .filter((present) => present).length
      if (selectors !== 1) {
        throw new ScheduleInputError("invalid_rule", "exactly one of after_seconds, at, every_seconds must be provided.")
      }
      const folded = foldScheduleEvents(ownEvents(deps.session))
      const id = allocateScheduleId(folded)
      const now = Date.now()
      const record: ScheduleRecord = args.after_seconds !== undefined
        ? createAfterScheduleRecord(id, args.prompt, args.after_seconds, now)
        : args.at !== undefined
          ? createAtScheduleRecord(id, args.prompt, args.at, now)
          // selectors === 1 and the other two are absent ⇒ every_seconds is present
          : createEveryScheduleRecord(id, args.prompt, args.every_seconds as number, now)
      append(deps.session, { type: "schedule/change", version: 1, operation: "create", schedule: record })
      return { id: record.id, kind: record.kind, scheduledAt: record.scheduledAt }
    },
  }
}

function createScheduleListTool(deps: ScheduleToolDeps): Tool<Record<string, never>, { schedules: ScheduleView[] }> {
  return {
    name: "schedule_list",
    description: "list the schedules created in the current session (this session's own events only); each carries its id, kind, prompt, scheduledAt and state — scheduled while the target is ahead, overdue once it has passed",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async () => {
      const folded = foldScheduleEvents(ownEvents(deps.session))
      const now = Date.now() // one instant for the whole list, so the states are a single snapshot
      return { schedules: folded.active.map((record) => scheduleView(record, now)) }
    },
  }
}

function createScheduleDeleteTool(deps: ScheduleToolDeps): Tool<{ id: string }, { deleted: string }> {
  return {
    name: "schedule_delete",
    description: "delete one schedule by id (schedule-<n>) from THIS session",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    isReadOnly: false,
    isConcurrencySafe: false,
    execute: async ({ id }) => {
      const folded = foldScheduleEvents(ownEvents(deps.session))
      if (!folded.active.some((record) => record.id === id)) {
        throw new Error(`schedule_delete: no active schedule with id ${JSON.stringify(id)}`) // soft body failure (tool pipeline block ①); NOT a durable write
      }
      append(deps.session, { type: "schedule/change", version: 1, operation: "delete", id })
      return { deleted: id }
    },
  }
}

export function createScheduleTools(deps: ScheduleToolDeps): Tool[] {
  return [createScheduleCreateTool(deps), createScheduleListTool(deps), createScheduleDeleteTool(deps)]
}
