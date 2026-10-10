export interface SubagentRole {
  /** Live plugin-owned roles are reconstructed from the current registry. */
  ephemeral?: boolean
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  // No `extra`: per-role request-body options have no producer (settings,
  // toSubagentRoles and the CLI all omit them) and, since the model resolution
  // moved to the host's resolver, no consumer either. A field nothing sets is a
  // capability the type advertises and the code does not honour — it lands
  // again only with a producer AND a consumer.
  model?: { provider: string; model: string }
}

export interface RoleRegistry {
  revision(name?: string): number
  onChanged(listener: () => void): () => void
  register(role: SubagentRole): void
  get(name: string): SubagentRole | undefined
  list(): SubagentRole[]
  remove(name: string): void
}

export function createRoleRegistry(): RoleRegistry {
  const roles = new Map<string, SubagentRole>()
  let revision = 0
  const roleRevisions = new Map<string, number>()
  const listeners = new Set<() => void>()
  const changed = (name: string) => { revision++; roleRevisions.set(name, (roleRevisions.get(name) ?? 0) + 1); for (const listener of listeners) listener() }
  return {
    revision: name => name === undefined ? revision : roleRevisions.get(name) ?? 0,
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    register(role) {
      if (roles.has(role.name)) throw new Error(`duplicate role: ${role.name}`)
      roles.set(role.name, role)
      changed(role.name)
    },
    get(name) { return roles.get(name) },
    list() { return [...roles.values()] },
    remove(name) { if (roles.delete(name)) changed(name) },
  }
}

// Built-in roles (patterned on opencode's built-in agent prompts). None carry
// a model — they inherit the parent ModelClient unless the user edits them.
export function builtinRoles(options: { agentShell?: boolean; nativeContext?: boolean } = {}): SubagentRole[] {
  const roles:SubagentRole[] = [
    {
      name: "general",
      description: "General agent for researching questions and executing multi-step tasks.",
      systemPrompt: "You are a general-purpose coding agent. Investigate the task, execute steps, and report concrete results with evidence.",
      tools: [...(options.agentShell ? ["shell"] : []), "bash", "pwsh", "read", "write", "list_dir", "grep"],
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
      tools: [...(options.agentShell ? ["shell"] : []), "bash", "pwsh", "read", "write", "list_dir", "grep"],
    },
  ]
  if(options.nativeContext) for(const role of roles){
    role.tools.push('context_output_search','context_output_read','context_output_status','code_context_search','code_context_status')
    if(role.name==='general'||role.name==='worker') role.tools.push('code_context_index')
  }
  return roles
}
