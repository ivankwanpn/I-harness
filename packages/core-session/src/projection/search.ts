import type { SessionEventView as SessionEvent } from "../managed/types.ts"
import { imageDescriptor, imageSummaryDescriptor } from "../images.ts"
import type { ImageInput } from "../images.ts"

// Canonical event→searchable-text normalizer for the session-query FTS index
// (M10b). Control events and assistant/chunk (streaming noise duplicating the
// final assistant/message) contribute no text.
export function deriveSearchText(ev: SessionEvent): string {
  switch (ev.type) {
    case "user/message":
      return ev.text + (ev.imageSummaries?.length ? imageSummaryDescriptor(ev.imageSummaries) : imageDescriptor(ev.images))
    case "assistant/message":
      return ev.text
    case "tool/call":
      return JSON.stringify(ev.args) ?? ""
    case "code/call":
      return `${ev.name} ${codeSearchText(ev.args)}`
    case "code/result":
      return codeSearchText(ev.output)
    case "code/output": {
      if (typeof ev.content === "string") return ev.content
      if (ev.content && typeof ev.content === "object" && !Array.isArray(ev.content)) {
        const item = ev.content as { type?: unknown; text?: unknown }
        return item.type === "text" && typeof item.text === "string" ? item.text : ""
      }
      return ""
    }
    case "tool/result": {
      // Images never enter the FTS index: strip `output.images` before
      // stringifying so base64 payloads stay out of search text.
      const raw = ev.output
      if (raw === undefined) return ""
      if (typeof raw !== "object" || raw === null) return JSON.stringify(raw)
      // Array-shaped outputs (host-defined tool output) are opaque — never
      // destructure them into `{0:1,1:2}`; stringify the array as-is.
      if (Array.isArray(raw)) return JSON.stringify(raw)
      const { images, ...rest } = raw as Record<string, unknown>
      return JSON.stringify(rest) + imageDescriptor(images as ImageInput[] | undefined)
    }
    case "subagent/inbox":
      return ev.message
    case "compaction/summary":
    case 'compaction/replacement':
      return ev.text
    // M19: only the two content-bearing team events are FTS-searchable
    // (team/member and team/message/delivered carry no user-facing text —
    // they stay unindexed via default "").
    case "team/task":
      return ev.task.subject + " " + ev.task.description
    case "team/message/queued":
      return ev.message.content
    case "subagent/start":
      return `${ev.description} ${ev.agentPath}`
    case "subagent/end":
      return ev.resultText ?? ev.error ?? ""
    default:
      return ""
  }
}

/** Code Mode may carry nested MCP media blocks, not only a top-level images
 * member. Search indexes their textual companions without transport bytes. */
function codeSearchText(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value, (key, child) => {
    if (["images", "image", "audioUrl", "dataBase64"].includes(key)) return undefined
    if (child && typeof child === "object" && ["image", "audio"].includes(child.type)) return undefined
    return child
  }) ?? ""
}
