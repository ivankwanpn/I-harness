import { SYSTEM_INPUT_PLUGIN, type ImageInput, type SessionView as Session, type SessionEvent } from "@i-harness/core-session"
import type { AgentInputOptions } from "./types.ts"

/** Resolve the recorded source before opening a turn; a conflict cannot append a partial turn. */
export function prepareTurnInput(session: Session, input: { message: string; images?: ImageInput[]; inputId?: string; options?: AgentInputOptions; producer: string }): Extract<SessionEvent, { type: "user/message" }> {
  const { message, inputId, options, producer } = input
  const admitted = inputId ? session.events.findLast((event) => event.type === "agent/input/admitted" && event.inputId === inputId && event.text === message) : undefined
  const admission = admitted?.type === "agent/input/admitted" ? admitted : undefined
  if (admission?.provenance && options?.provenance) {
    const fields = ["kind", "authority", "scope", "producer", "originSessionId"] as const
    if (fields.some(key => admission.provenance![key] !== options.provenance[key])) throw new Error("input provenance conflicts with recorded admission")
  }
  const provenance = admission ? admission.provenance : options?.provenance ?? { kind: "unknown", authority: "unknown", scope: "turn", producer } as const
  const images = admission ? admission.images : input.images
  return {
    type: "user/message", text: message,
    ...(provenance ? { provenance } : {}),
    ...(images?.length ? admission ? { imageInputId: admission.inputId } : { images: [...images] } : {}),
    ...(admission ? {
      input: { inputId: admission.inputId, intent: admission.intent,
        ...(admission.provenance ? { provenance: admission.provenance } : {}),
        ...(admission.synthetic !== undefined ? { synthetic: admission.synthetic } : {}),
      },
      ...(admission.intent === "system" ? { source: { kind: "plugin" as const, plugin: SYSTEM_INPUT_PLUGIN } } : {}),
    } : {}),
  }
}
