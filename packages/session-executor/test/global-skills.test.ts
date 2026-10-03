import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createSessionAssembly } from "../src/assembly.ts"
it("uses the host-confirmed custom global skill directory in the actual assembly tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-global-skill-"))
  const workspace = join(root, "workspace"); const globalDir = join(root, "settings", "skills")
  await mkdir(workspace)
  await mkdir(join(globalDir, "custom-global"), { recursive: true })
  await writeFile(join(globalDir, "custom-global", "SKILL.md"), "---\nname: custom-global\ndescription: Custom configured global skill\n---\ncustom global content")
  const assembly = await createSessionAssembly({ workspace, modelPolicy: "test-mock", skills: { globalDir } })
  try {
    const result = await assembly.tools.execute({ name: "skill_get", args: { name: "custom-global" } })
    expect(JSON.stringify(result.output)).toContain("custom global content")
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})
