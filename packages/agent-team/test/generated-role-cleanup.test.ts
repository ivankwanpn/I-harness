import { describe, expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createAgentTable, createJobRegistry, createRoleRegistry } from '@i-harness/subagent'
import { registerExec } from '@i-harness/exec'
import { mountAgentTeams, type TeamDeps } from '../src/scheduler.ts'
import { controlledModel } from '../../subagent/test/generation-fixture.ts'
function makeDeps(): TeamDeps {
 return { parentSession:createSession(), parentRegistry:createToolRegistry(createContext()),
 subagents:{table:createAgentTable(),jobs:createJobRegistry(),roles:createRoleRegistry(),agents:createAgentRegistry(),exec:registerExec(createContext()),resolveModel:async()=>({status:'unconfigured',reason:'unused'})},
 parentModel:controlledModel(async function*(){yield {type:'end'} as const}) }
}
// Team owns the original registration cleanup, independently of public admission.
describe('generated Team role cleanup', () => {
  it('closes after public registry retirement without using public remove', async () => {
    const deps = makeDeps(), actual = deps.subagents.roles
    let retired = false
    const remove = vi.fn((name: string) => { if (retired) throw Error('Task registry retired'); actual.remove(name) })
    deps.subagents.roles = { ...actual, remove }
    const ctx = createContext(), handle = await mountAgentTeams(ctx, createToolRegistry(ctx), deps)
    retired = true
    await handle.unmount()
    expect(actual.get('teammate')).toBeUndefined()
    expect(remove).not.toHaveBeenCalled()
  })

  it('preserves a replacement even when it reuses the same role object', async () => {
    const deps = makeDeps(), actual = deps.subagents.roles
    const ctx = createContext(), handle = await mountAgentTeams(ctx, createToolRegistry(ctx), deps)
    const original = actual.get('teammate')!
    actual.remove('teammate'); actual.register(original)
    await handle.unmount()
    expect(actual.get('teammate')).toBe(original)
    actual.remove('teammate')
  })

  it('reports missing original cleanup instead of deleting by name', async () => {
    const deps = makeDeps(), actual = deps.subagents.roles
    deps.subagents.roles = { ...actual, register(role) { actual.register(role) } }
    const ctx = createContext(), handle = await mountAgentTeams(ctx, createToolRegistry(ctx), deps)
    await expect(handle.unmount()).rejects.toThrow('Team cleanup incomplete')
    expect(actual.get('teammate')).toBeDefined()
    actual.remove('teammate')
    await handle.unmount()
  })

  it('awaits original cleanup acknowledgement and retries its failed save', async () => {
    const deps = makeDeps(), actual = deps.subagents.roles
    let fail = true, saves = 0
    const { persistentRoleRegistry } = await import('../../subagent/src/persist.ts')
    deps.subagents.roles = persistentRoleRegistry(actual, async () => { saves++; if (saves > 1 && fail) throw Error('cleanup save failed') })
    const ctx = createContext(), handle = await mountAgentTeams(ctx, createToolRegistry(ctx), deps)
    await expect(handle.unmount()).rejects.toThrow('Team cleanup incomplete')
    expect(actual.get('teammate')).toBeUndefined()
    fail = false
    await handle.unmount()
    expect(saves).toBe(3)
  })

  it('retains cleanup when registration publishes then throws', async () => {
    const deps = makeDeps(), actual = deps.subagents.roles
    deps.subagents.roles = { ...actual, register(role, retain) { actual.register(role, retain); throw Error('registration listener failed') } }
    const ctx = createContext()
    await expect(mountAgentTeams(ctx, createToolRegistry(ctx), deps)).rejects.toThrow('registration listener failed')
    expect(actual.get('teammate')).toBeUndefined()
  })
})
