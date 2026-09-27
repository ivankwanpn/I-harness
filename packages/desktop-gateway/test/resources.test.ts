import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createDesktopResources } from "../src/resources.ts"
afterEach(() => vi.unstubAllEnvs())
it("uses the engine's effective skill precedence and returns command bodies only on selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-resources-"))
  vi.stubEnv("IH_CONFIG_DIR", join(root, "home"))
  const workspace = join(root, "workspace"), plugin = join(root, "plugins", "skills", "fixture")
  for (const [directory, text] of [[join(root, "home", "skills"), "global"], [plugin, "plugin"], [join(workspace, "skills"), "workspace"]]) {
    await mkdir(join(directory!, "hello"), { recursive: true })
    await writeFile(join(directory!, "hello", "SKILL.md"), `---\nname: hello\ndescription: A greeting\n---\n${text}`)
  }
  const resources = createDesktopResources(workspace, async () => ({ skillDirs: [plugin], commandDescriptors: [{ name: "hello", pluginId: "fixture", description: "Greet", body: "Prompt body $ARGUMENTS", unsupported: ["allowed-tools"] }], agentDescriptors: [], mcpServerConfigs: {}, hookConfigs: [] }))
  try {
    const skills = await resources.list("skills", "", 0)
    expect(skills.items).toMatchObject([{ name: "hello", source: "workspace" }])
    expect(await resources.read("skills", "hello")).toMatchObject({ body: "workspace" })
    const commands = await resources.list("commands", "", 0)
    expect(JSON.stringify(commands)).not.toContain("Prompt body")
    expect(await resources.read("commands", "hello")).toMatchObject({ pluginId: "fixture", body: "Prompt body $ARGUMENTS", unsupported: ["allowed-tools"] })
  } finally { await rm(root, { recursive: true, force: true }) }
})
