// @i-harness/tui — M49 Task 10: typed tool presentation surface.
// The single import point for the presentation module: the redaction seam
// (spec §7.3), the ToolPresentation shape and the family formatters.
export { redactToolPayload, SECRET_KEYS, REDACTED } from "./redact.ts"
export {
  presentTool,
  formatExecute,
  formatRead,
  formatEdit,
  formatList,
  formatSearch,
  formatWebFetch,
  formatWebSearch,
  formatMcp,
  formatSkill,
  formatSubagent,
  formatTodo,
  formatGeneric,
  GROUPABLE_KINDS,
} from "./format.ts"
export type { ToolPresentation, ToolBodyEntry, ToolEventLike } from "./format.ts"
