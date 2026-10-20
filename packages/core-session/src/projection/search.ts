import type { SessionEventView as SessionEvent } from "../managed/types.ts"
import { imageDescriptor, imageSummaryDescriptor } from "../images.ts"
import type { ImageInput } from "../images.ts"
import { stringifyJsonData } from '../serialization/json-data.ts'
import type { ResultEnvelope } from '../results/types.ts'

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
      return ev.envelope ? retainedSearchText(ev.envelope) : codeSearchText(ev.output)
    case "code/output": {
      if (ev.envelope) return retainedSearchText(ev.envelope)
      if (typeof ev.content === "string") return ev.content
      if (ev.content && typeof ev.content === "object" && !Array.isArray(ev.content)) {
        const item = ev.content as { type?: unknown; text?: unknown }
        return item.type === "text" && typeof item.text === "string" ? item.text : ""
      }
      return ""
    }
    case "tool/result": {
      if (ev.envelope) return retainedSearchText(ev.envelope)
      // Historical raw results exclude image transport bytes and retain the
      // original image descriptor. New inline fields remain ordinary data.
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
      // Current child facts own one aggregate preview in these fields; their
      // retained descriptor deliberately clears its separate preview.
      return ev.envelope
        ? [ev.resultText, ev.error].filter(text => typeof text === 'string').join('\n')
        : ev.resultText ?? ev.error ?? ""
    default:
      return ""
  }
}

/** Bounded result facts only: typed media, refs and dependencies are separate
 * metadata. Artifact bodies are never read implicitly by the search index. */
function retainedSearchText(envelope: ResultEnvelope): string {
  return envelope.retention.kind === 'inline'
    ? stringifyJsonData(envelope.retention.value) ?? 'null'
    : envelope.preview
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
