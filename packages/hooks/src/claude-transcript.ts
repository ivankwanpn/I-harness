import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeHookSession } from "./types.ts"
import { HookConfigError } from "./types.ts"
import { claudeToolInput, claudeToolName } from "./claude.ts"

// A hook receives an immutable bounded projection, not the native store path.
// Files exist only for that subprocess and are also reclaimed on dispose.
export function createClaudeTranscriptProjection() {
  let folder: Promise<string> | undefined
  let sequence = 0
  let disposed = false
  const tail = (text: string): string => text.length > 32768 ? `[earlier text omitted]\n${text.slice(-32768)}` : text
  return {
    async capture(session: ClaudeHookSession, sessionId: string, cwd: string): Promise<{ path: string; release(): Promise<void> }> {
      if (disposed) throw new HookConfigError("Claude transcript projection is disposed")
      const rows: string[] = []
      const seedLength = (session as ClaudeHookSession & { header?: { seedLength?: number } }).header?.seedLength
      const ownStart = typeof seedLength === "number" && Number.isSafeInteger(seedLength) && seedLength >= 0 && seedLength <= session.events.length ? seedLength : 0
      for (const raw of session.events.slice(Math.max(ownStart, session.events.length - 512))) {
        if (typeof raw !== "object" || raw === null) continue
        const event = raw as Record<string, unknown>
        let role: "assistant" | "user"
        let content: unknown[]
        if ((event.type === "assistant/message" || event.type === "user/message") && typeof event.text === "string") {
          role = event.type === "assistant/message" ? "assistant" : "user"
          content = [{ type: "text", text: tail(event.text) }]
        } else if (event.type === "tool/call" && typeof event.name === "string" && typeof event.callId === "string") {
          role = "assistant"
          content = [{ type: "tool_use", id: event.callId, name: claudeToolName(event.name), input: claudeToolInput(event.name, event.args, cwd) }]
        } else if (event.type === "tool/result" && typeof event.callId === "string") {
          role = "user"
          let output: string
          try { output = typeof event.output === "string" ? event.output : JSON.stringify(event.output) ?? "" } catch { output = "[unserializable tool output]" }
          content = [{ type: "tool_result", tool_use_id: event.callId, content: tail(output), ...(event.isError === true ? { is_error: true } : {}) }]
        } else continue
        try { rows.push(JSON.stringify({ type: role, sessionId, message: { role, content } })) } catch { /* unprojectable event, native history remains intact */ }
      }
      const selected: string[] = []
      let bytes = 0
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!, length = Buffer.byteLength(row) + 1
        if (length > 1024 * 1024) continue
        if (bytes + length > 1024 * 1024) break
        selected.push(row); bytes += length
      }
      const directory = await (folder ??= mkdtemp(join(tmpdir(), "ih-claude-transcript-")))
      if (disposed) { await rm(directory, { recursive: true, force: true }); throw new HookConfigError("Claude transcript projection is disposed") }
      const path = join(directory, `${++sequence}.jsonl`)
      await writeFile(path, selected.reverse().join("\n") + "\n", { mode: 0o600, flag: "wx" })
      return { path, release: () => rm(path, { force: true }) }
    },
    async dispose(): Promise<void> {
      disposed = true
      if (folder) await rm(await folder, { recursive: true, force: true })
    },
  }
}
