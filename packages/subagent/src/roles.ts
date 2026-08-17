export interface SubagentRole {
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  model?: { provider: string; model: string; extra?: Record<string, unknown> }
}

export interface RoleRegistry {
  register(role: SubagentRole): void
  get(name: string): SubagentRole | undefined
  list(): SubagentRole[]
  remove(name: string): void
}

export function createRoleRegistry(): RoleRegistry {
  const roles = new Map<string, SubagentRole>()
  return {
    register(role) {
      if (roles.has(role.name)) throw new Error(`duplicate role: ${role.name}`)
      roles.set(role.name, role)
    },
    get(name) { return roles.get(name) },
    list() { return [...roles.values()] },
    remove(name) { roles.delete(name) },
  }
}

// Built-in roles (patterned on opencode's built-in agent prompts). None carry
// a model — they inherit the parent ModelClient unless the user edits them.
export function builtinRoles(): SubagentRole[] {
  return [
    {
      name: "general",
      description: "General agent for researching questions and executing multi-step tasks.",
      systemPrompt: "You are a general-purpose coding agent. Investigate the task, execute steps, and report concrete results with evidence.",
      tools: ["bash", "pwsh", "read", "write", "list_dir", "grep"],
    },
    {
      name: "explore",
      description: "Fast agent specialized for exploring codebases.",
      systemPrompt: "You are an exploration agent. Find files by pattern and answer questions about the codebase quickly. Do not modify files.",
      tools: ["read", "list_dir", "grep", "glob"],
    },
    {
      name: "research",
      description: "Deep research agent for evidence-based, cross-module analysis.",
      systemPrompt: "You are a research specialist. Investigate the assigned question using read-only tools, build conclusions from evidence, and cite file paths and line ranges. Do not modify files.",
      tools: ["read", "list_dir", "grep"],
    },
    {
      name: "worker",
      description: "Strong implementation agent for code changes, tests, and verification.",
      systemPrompt: "You are an implementation agent. Make the requested code changes, write tests, and verify them. Report what changed and the verification result.",
      tools: ["bash", "pwsh", "read", "write", "list_dir", "grep"],
    },
  ]
}
