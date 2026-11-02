import { join } from 'node:path'
import type { ManagedRegistryConstruction } from '../../session-executor/src/managed-assembly.ts'
import type { RoleRegistry } from '@i-harness/subagent'
import type { RuntimeInputs } from '@i-harness/plugin-registry'
import { createOwnedPluginCatalog } from '../../session-executor/src/owned-plugin-catalog.ts'
import { createOwnedPluginMount, type OwnedPluginMountOptions } from './owned-plugin-mount.ts'
import { approvalPolicyIdentityFromSources, type ApprovalIdentityOptions } from './approval-policy-identity.ts'
import type { InteractionBridge } from './interaction.ts'

/** Mount onto the original registry. The caller must route ownedPolicyIdentity
 * to identity() for this exact owner before attaching the interaction bridge. */
export async function mountOwnedHostExtensions(original: ManagedRegistryConstruction, options: {
  roles: RoleRegistry; workspace: string; configDir: string; startSource: 'startup' | 'resume'
  inputs: RuntimeInputs; directMcp?: OwnedPluginMountOptions['directMcp']; report(messages: string[]): void
  interaction: InteractionBridge; modelTools(): unknown
  policy(): Omit<ApprovalIdentityOptions, 'hookAuthority'>
  bindIdentity(owner: { ctx: ManagedRegistryConstruction['ctx']; sessionId: string; tools: ManagedRegistryConstruction['tools'] }, identity: () => { workspaceId: string; revision: string } | undefined): void
}) {
  original.assertCurrent()
  const catalog = createOwnedPluginCatalog({ ctx: original.ctx, tools: original.tools, roles: options.roles,
    workspace: options.workspace, globalSkillDir: join(options.configDir, 'skills'), report: message => options.report([message]) })
  let mount: ReturnType<typeof createOwnedPluginMount> | undefined, closed = false
  original.retain(async () => { closed = true; if (mount) await mount.close(); else await catalog.close() })
  mount = createOwnedPluginMount({ ctx: original.ctx, sessionId: original.domain.sessionId, startSource: options.startSource,
    configDir: options.configDir, workspace: options.workspace, report: options.report, catalog, directMcp: options.directMcp })
  const owner = { ctx: original.ctx, sessionId: original.domain.sessionId, tools: original.tools }
  const identity = () => approvalPolicyIdentityFromSources(() => {
    if (closed) throw Error('Owned host retired')
    original.assertCurrent()
    const observation = original.execution.observe()
    const plan = observation.plan()
    const result = { plan, roles: options.roles.list(), catalog: original.tools.genToolCatalog(), deferred: original.tools.deferredSearchIndex(),
      modelTools: options.modelTools(), mcp: [...catalog.mcpResults], agents: [...catalog.roleResults] }
    observation.assertCurrent(); original.assertCurrent()
    return result
  }, { ...options.policy(), hookAuthority: () => mount!.hookAuthority(options.policy().hookConfigs) })
  options.bindIdentity(owner, identity)
  options.interaction.attachOwned(owner)
  await mount.update(options.inputs)
  original.assertCurrent()
  return { mount, catalog, owner, identity }
}
