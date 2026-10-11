import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** A local marketplace with a skills-only plugin and a commands-only plugin. */
export async function writeSuggestionMarketplace(root: string) {
  const source = join(root, "marketplace")
  await mkdir(join(source, ".claude-plugin"), { recursive: true })
  await writeFile(join(source, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "suggestion-fixture",
    plugins: [
      { name: "superpowers", source: "./plugins/superpowers", description: "Skills-only fixture" },
      { name: "prompts", source: "./plugins/prompts", description: "Commands-only fixture" },
    ],
  }))
  for (const [name, description] of [["brainstorming", "Review a design before implementation"], ["shared", "Plugin shared skill"]]) {
    const directory = join(source, "plugins", "superpowers", "skills", name!)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nprivate skill body ${name}`)
  }
  const commands = join(source, "plugins", "prompts", "commands")
  await mkdir(commands, { recursive: true })
  await writeFile(join(commands, "review-changes.md"), "---\ndescription: Review changed files\nargument-hints: <file>\n---\nprivate command body $ARGUMENTS")
  await writeFile(join(commands, "shared.md"), "---\ndescription: Plugin shared command\n---\nprivate shared command body")
  return { source, skillsId: "suggestion-fixture__superpowers", commandsId: "suggestion-fixture__prompts" }
}
