/** Package-private adapter bridge. The only production adapter importer is the
 * concrete llm-bedrock SDK terminal, which owns client/command/handler/send.
 * This is an API/source boundary, not an in-process JavaScript sandbox. */
import { createPreparedPayload, type PreparedPayloadOptions } from './payload.ts'
import { ownPreparedTerminal } from './owned-terminal.ts'
export type BedrockTerminalPayloadOptions<T> = PreparedPayloadOptions<T>
export function createBedrockTerminalPayload<T>(options: PreparedPayloadOptions<T>) {
  return ownPreparedTerminal(createPreparedPayload(options))
}
