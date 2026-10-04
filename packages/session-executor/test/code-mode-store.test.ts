import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append } from "@i-harness/core-session"
import { createSessionCoordinator, forkSession } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"

it("restores JSON through the real durable executor and copies visible state through repeated session forks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-store-executor-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const options = { workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: "test-mock" as const, sandbox: "danger-full-access" as const, codeMode: { mode: "only" as const } }
  let service = createSessionService(options)
  await coordinator.create({ sessionId: "source" })
  try {
    let source = await service.assemblyFor("source")
    append(source.session, { type: "turn/start" }); append(source.session, { type: "user/message", text: "save data" })
    expect((await source.tools.execute({ name: "code_exec", args: { code: 'store("value",{count:7});globalThis.secret=1;' } })).output).toMatchObject({ status: "completed" })
    append(source.session, { type: "turn/end" })
    await coordinator.flush("source")
    expect((await coordinator.snapshot!("source")).session.events.some(event => event.type === "code/store" as string)).toBe(true)
    const fork = await forkSession(coordinator, "source")
    await service.close(); service = createSessionService(options)
    source = await service.assemblyFor("source")
    expect((await source.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));text(typeof secret);' } })).output).toMatchObject({ text: '{"count":7}\nundefined' })
    const child = await service.assemblyFor(fork.sessionId)
    expect((await child.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));store("value",{count:8});' } })).output).toMatchObject({ text: '{"count":7}' })
    append(child.session, { type: "turn/start" }); append(child.session, { type: "user/message", text: "child boundary" }); append(child.session, { type: "turn/end" })
    await coordinator.flush(fork.sessionId)
    const next = await forkSession(coordinator, fork.sessionId)
    const grandchild = await service.assemblyFor(next.sessionId)
    expect((await grandchild.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));' } })).output).toMatchObject({ text: '{"count":8}' })
    expect((await source.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));' } })).output).toMatchObject({ text: '{"count":7}' })
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)
