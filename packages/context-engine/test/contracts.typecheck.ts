import { renderConversation, type ConversationProjection } from "@i-harness/core-session"
import type { Captured, ContextSnapshot, ImmutableJson } from "../src/index.ts"

export function checkSnapshotAssignments(snapshot: ContextSnapshot, conversation: Captured<ConversationProjection>) {
  renderConversation(conversation)
  const tools: readonly { readonly inputSchema: ImmutableJson }[] = snapshot.surface.tools
  // @ts-expect-error Captured tools may not be pushed by consumers.
  snapshot.surface.tools.push({ name: "mutation", description: "", inputSchema: {} })
  // @ts-expect-error Captured unknown leaves cannot be an arbitrary class/function.
  const invalid: Captured<unknown> = () => "not JSON"
  return { tools, invalid }
}
