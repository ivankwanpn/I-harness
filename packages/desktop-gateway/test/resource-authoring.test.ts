import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm, rmdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSkillRegistry } from "@i-harness/skills"
import { createSessionService } from "@i-harness/session-executor"
import { runCommand } from "@i-harness/interaction"
import { createDesktopResources } from "../src/resources.ts"
import { pluginExtensions } from "../src/plugin-mount.ts"
afterEach(() => vi.unstubAllEnvs())
const empty = { skillDirs: [], commandDescriptors: [], agentDescriptors: [], mcpServerConfigs: {}, hookConfigs: [] }

it("authors real skill and command files consumed by an existing engine and rejects stale bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-authoring-")), home = join(root, "home"), workspace = join(root, "work")
  vi.stubEnv("IH_CONFIG_DIR", home)
  await mkdir(workspace)
  const resources = createDesktopResources(workspace, async () => empty)
  const service = createSessionService({ workspace, model: { async *stream() { yield { type: "end" as const } } }, extensionsFor: async id => pluginExtensions(await resources.effectiveInputs(), home, id, () => {}) })
  try {
    const body = "\uFEFF---\r\nname: edited\r\ndescription: Test\r\nextra: retained\r\n---\r\nold content\r\n"
    expect(await resources.write({ resourceKind: "skills", source: "workspace", name: "edited", body, expectedRevision: null })).toMatchObject({ kind: "saved" })
    const detail = (await resources.read("skills", "edited", "workspace"))!
    expect(detail.rawBody).toBe(body)
    expect(detail.revision).toMatch(/^[a-f0-9]{64}$/)
    expect((await createSkillRegistry({ workspace }).getSkill("edited"))?.body).toContain("old content")
    const edited = body.replace("old content", "new content")
    // Browser textareas normalize CRLF to LF; the file author preserves its
    // existing encoding/line-ending convention when saving the edit.
    expect(await resources.write({ resourceKind: "skills", source: "workspace", name: "edited", body: edited.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"), expectedRevision: detail.revision! })).toMatchObject({ kind: "saved" })
    expect(await readFile(join(workspace, "skills", "edited", "SKILL.md"), "utf8")).toBe(edited)
    expect((await createSkillRegistry({ workspace }).getSkill("edited"))?.body).toContain("new content")
    await writeFile(join(workspace, "skills", "edited", "SKILL.md"), edited + "external")
    expect(await resources.write({ resourceKind: "skills", source: "workspace", name: "edited", body: "draft", expectedRevision: detail.revision! })).toMatchObject({ kind: "conflict" })
    await resources.write({ resourceKind: "commands", source: "global", name: "review-local", body: "Global $ARGUMENTS", expectedRevision: null })
    const assembly = await service.assemblyFor("s")
    expect(await runCommand(assembly.ctx, "review-local", "file")).toMatchObject({ text: "Global file" })
    await resources.write({ resourceKind: "commands", source: "workspace", name: "review-local", body: "Workspace $ARGUMENTS", expectedRevision: null })
    await service.refreshExtensions()
    expect(await runCommand(assembly.ctx, "review-local", "file")).toMatchObject({ text: "Workspace file" })
    const command = (await resources.read("commands", "review-local", "workspace"))!
    await resources.remove({ resourceKind: "commands", source: "workspace", name: "review-local", expectedRevision: command.revision! })
    await service.refreshExtensions()
    expect(await runCommand(assembly.ctx, "review-local", "file")).toMatchObject({ text: "Global file" })
    expect(await readFile(join(workspace, "skills", "edited", "SKILL.md"), "utf8")).toContain("external")
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it("copies plugin content locally, preserves source identity, validates names and refuses symlink scope escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-authoring-scope-")), home = join(root, "home"), workspace = join(root, "work"), plugin = join(root, "plugin")
  vi.stubEnv("IH_CONFIG_DIR", home)
  await mkdir(join(plugin, "shared"), { recursive: true }); await mkdir(workspace)
  const raw = "---\nname: shared\ndescription: Plugin\n---\nPlugin body"
  await writeFile(join(plugin, "shared", "SKILL.md"), raw)
  const resources = createDesktopResources(workspace, async () => ({ ...empty, skillDirs: [plugin], commandDescriptors: [{ name: "shared", pluginId: "fixture", body: "Plugin command" }] }))
  try {
    await expect(resources.write({ resourceKind: "skills", source: "plugin" as "workspace", name: "shared", body: raw, expectedRevision: null })).rejects.toThrow(/source/)
    const source = (await resources.read("skills", "shared", "plugin"))!
    await resources.write({ resourceKind: "skills", source: "workspace", name: "shared", body: source.rawBody!, expectedRevision: null })
    expect(await resources.read("skills", "shared", "plugin")).toMatchObject({ body: "Plugin body", source: "plugin" })
    expect(await readFile(join(plugin, "shared", "SKILL.md"), "utf8")).toBe(raw)
    const imported = await resources.importSkill("global", join(plugin, "shared", "SKILL.md"))
    expect(imported).toEqual({ name: "shared", body: raw, source: "global" })
    await resources.write({ resourceKind: "skills", source: "global", name: imported.name, body: imported.body, expectedRevision: null })
    expect(await resources.read("skills", "shared", "global")).toMatchObject({ source: "global", rawBody: raw })
    expect((await resources.list("skills", "shared", 0, true)).items).toEqual(expect.arrayContaining([expect.objectContaining({ source: "global", effective: false }), expect.objectContaining({ source: "plugin", effective: false }), expect.objectContaining({ source: "workspace", effective: true })]))
    await mkdir(join(home, "plugins", "commands", "fixture"), { recursive: true })
    const rawCommand = "---\r\ndescription: Retain metadata\r\nargument-hints: <file>\r\nallowed-tools: Read\r\n---\r\nPlugin command"
    await writeFile(join(home, "plugins", "commands", "fixture", "shared.md"), rawCommand)
    await resources.write({ resourceKind: "commands", source: "workspace", name: "shared", body: "Local override", expectedRevision: null })
    expect(await resources.read("commands", "shared", "plugin", "fixture")).toMatchObject({ rawBody: rawCommand, source: "plugin" })
    for (const name of ["../outside", "Bad", "con", "a/b"]) await expect(resources.write({ resourceKind: "commands", source: "workspace", name, body: "body", expectedRevision: null })).rejects.toThrow(/name/)
    await rm(join(workspace, "commands", "shared.md")); await rmdir(join(workspace, "commands"))
    await symlink(plugin, join(workspace, "commands"), "junction")
    await expect(resources.write({ resourceKind: "commands", source: "workspace", name: "escape", body: "body", expectedRevision: null })).rejects.toThrow(/symlink/)
    expect((await resources.effectiveInputs()).commandDescriptors.find(row => row.name === "shared")?.body).toBe("Plugin command")
  } finally { await rm(root, { recursive: true, force: true }) }
})
