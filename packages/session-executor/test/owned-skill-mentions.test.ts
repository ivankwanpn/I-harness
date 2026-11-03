import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createContext, captureExecutionHookChannel } from "@i-harness/core-plugin"
import { createSkillRegistry, SKILL_MENTION_PLUGIN } from "@i-harness/skills"
import { createManagedAgentModelOriginOwner } from "@i-harness/core-agent/model-origin"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/task-document-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { acquireManagedExecution } from "../../session-persistence/src/execution-internal.ts"
import { mountOwnedSkillMentions } from "../src/owned-skill-mentions.ts"

it("publishes the original skill mention feedback once through the actual managed owner", async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "mention-"))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "main" })
    const dir = join(root, "skills", "helper"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "SKILL.md"), "---\nname: helper\ndescription: helps\n---\nbody\n")
    const execution = await acquireManagedExecution(coordinator, "main"), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution)
    const owner = mountOwnedSkillMentions({ ctx, execution, domain: origin.domain, registry: createSkillRegistry({ workspace: root, globalDir: join(root, "global") }) })
    const hooks = captureExecutionHookChannel(ctx)
    await hooks.emit("agent/pre-step", { task: "use $helper", domain: {} })
    expect((await backend.read("main")).events.filter(event => event.type === "user/message")).toHaveLength(0)
    await hooks.emit("agent/pre-step", { task: "use $helper", domain: origin.domain })
    await hooks.emit("agent/pre-step", { task: "use $helper", domain: origin.domain })
    const events = (await backend.read("main")).events.filter(event => event.type === "user/message" && event.source?.kind === "plugin" && event.source.plugin === SKILL_MENTION_PLUGIN)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ text: expect.stringContaining('"helper"') })
    await owner.close()
    await hooks.emit("agent/pre-step", { task: "again $helper", domain: origin.domain })
    expect((await backend.read("main")).events.filter(event => event.type === "user/message" && event.source?.kind === "plugin" && event.source.plugin === SKILL_MENTION_PLUGIN)).toHaveLength(1)
    await execution.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
