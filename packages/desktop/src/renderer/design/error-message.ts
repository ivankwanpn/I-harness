/** Display the underlying operation failure without Electron's IPC framing.
 * Recorded tool output is never passed through this presentation helper.
 */
export function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  const framed = message.match(/^(?:Error:\s*)?Error invoking remote method '[^'\r\n]+':\s*([\s\S]+)$/)
  return framed ? framed[1]!.replace(/^(?:(?:Error|RpcError):\s*){1,3}/, "") : message
}
