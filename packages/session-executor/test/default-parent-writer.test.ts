import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionService } from "../src/service.ts"

it("keeps a coordinator-only parent fresh while mirroring dispatch before the actual tool body", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-default-parent-writer-")), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: "parent" })
  let parentLoads = 0, calls = 0, bodySawDurableDispatch = false
  const observed = { ...coordinator, async loadOwned() { parentLoads++; throw new Error("Fresh parent must not be loaded or recovered") } }
  const model: ModelClient = { async *stream() {
    if (++calls === 1) yield { type: "tool_call", call: { name: "owned_dispatch_probe", args: {} } }
    else yield { type: "text/chunk", text: "Owned completion" }
    yield { type: "end" }
  } }
  const service = createSessionService({ workspace: root, coordinator: observed, model, codeMode: { mode: "off" }, sandbox: "read-only",
    additionalTools: [{ name: "owned_dispatch_probe", description: "Inspect this fixture's actual durable dispatch", inputSchema: { type: "object", properties: {} }, isReadOnly: true,
      execute: async () => {
        const events = (await backend.read("parent")).events
        const call = events.find(event => event.type === "tool/call" && event.name === "owned_dispatch_probe")
        bodySawDurableDispatch = call?.type === "tool/call" && events.some(event => event.type === "tool/dispatch" && event.callId === call.callId)
        return { actualDurableDispatch: bodySawDurableDispatch }
      },
    }],
  })
  try {
    const writer = await service.writableSessionFor!("parent")
    expect(writer!.events).toEqual([])
    const assembly = await service.assemblyFor("parent")
    expect(assembly.session).toBe(writer)
    await service.submit("parent", "Owned default-parent action", new AbortController().signal)
    expect(parentLoads).toBe(0)
    expect(bodySawDurableDispatch).toBe(true)
    const durable = (await backend.read("parent")).events
    expect(durable).toEqual(assembly.session.events)
    expect(durable.at(-1)?.type).toBe("turn/end")
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
