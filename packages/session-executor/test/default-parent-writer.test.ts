import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { controlledModel } from "./controlled-model.ts"
import { createSessionService } from "../src/service.ts"
import { append } from '@i-harness/core-session'

it("keeps a coordinator-only parent fresh while mirroring dispatch before the actual tool body", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-default-parent-writer-")), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  let parentLoads = 0, calls = 0, bodySawDurableDispatch = false
  const observed = { ...coordinator, async loadOwned() { parentLoads++; throw new Error("Fresh parent must not be loaded or recovered") } }
  const model = controlledModel(async function* () {
    if (++calls === 1) yield { type: "tool_call", call: { name: "owned_dispatch_probe", args: {} } }
    else yield { type: "text/chunk", text: "Owned completion" }
    yield { type: "end" }
  })
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
    expect(() => Reflect.apply(append,undefined,[writer!, { type: 'plan/mode', mode: 'on' }])).toThrow(/Managed/)
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

afterEach(() => vi.unstubAllGlobals())
