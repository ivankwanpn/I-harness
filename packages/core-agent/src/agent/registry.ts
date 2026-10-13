import type { Agent, AgentRegistry } from "./types.ts"

export function createAgentRegistry(): AgentRegistry {
  const agents = new Map<string, Agent>()
  return {
    register: (sessionId, agent) => {
      agents.set(sessionId, agent)
    },
    get: (sessionId) => agents.get(sessionId),
    remove: (sessionId) => {
      agents.delete(sessionId)
    },
    entries: () => agents,
  }
}
