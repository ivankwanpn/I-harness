import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSkillRegistry } from "../src/registry.ts"
afterEach(() => vi.unstubAllEnvs())
it("refuses symlink roots and symlink conventional probes without exposing their skill content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-skill-scope-")), workspace = join(root, "work"), outside = join(root, "outside"), home = join(root, "home")
  vi.stubEnv("IH_CONFIG_DIR", home)
  await mkdir(workspace); await mkdir(join(outside, "external"), { recursive: true }); await mkdir(home)
  await writeFile(join(outside, "external", "SKILL.md"), "---\nname: external\ndescription: Outside\n---\nExternal sensitive body")
  await symlink(outside, join(workspace, "skills"), "junction")
  const warnings: string[] = []
  const registry = createSkillRegistry({ workspace, onWarn: message => warnings.push(message) })
  try {
    expect(registry.list()).toEqual([])
    expect(await registry.getSkill("external")).toBeUndefined()
    expect(warnings.some(message => message.includes("symlink"))).toBe(true)
    await rm(join(workspace, "skills")); await mkdir(join(workspace, "skills"))
    await symlink(join(outside, "external"), join(workspace, "skills", "external"), "junction")
    expect(registry.list()).toEqual([])
    expect(await registry.getSkill("external")).toBeUndefined()
    await symlink(outside, join(home, "skills"), "junction")
    expect(createSkillRegistry({ globalDir: join(home, "skills"), extraDirs: [join(home, "skills")], onWarn: () => {} }).list()).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
