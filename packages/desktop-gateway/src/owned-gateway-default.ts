import type { ManagedRegistryConstruction } from '../../session-executor/src/managed-assembly.ts'
import { mountOwnedHostExtensions } from './owned-host-extensions.ts'
import { createOwnedDefaultSurface, type OwnedDefaultSurface } from './owned-default-surface.ts'
import type { createOwnedApprovalBindings } from './owned-approval-bindings.ts'
import { mountOwnedGatewayLeaves } from './owned-gateway-leaves.ts'

/** Called only by the future configured private-host selector after its native,
 * child and Code owners are attached to this same original registry. */
export async function composeOwnedGatewayDefault(original:ManagedRegistryConstruction, options:{
 extensions: Omit<Parameters<typeof mountOwnedHostExtensions>[1],'bindIdentity'|'modelTools'>
 surface: Omit<Parameters<typeof createOwnedDefaultSurface>[1],'prepareInput'|'skillsPrompt'>
 leaves: Parameters<typeof mountOwnedGatewayLeaves>[1]
 bindings: ReturnType<typeof createOwnedApprovalBindings>
}):Promise<OwnedDefaultSurface> {
 mountOwnedGatewayLeaves(original,options.leaves)
 let surface:OwnedDefaultSurface|undefined
 const extensions=await mountOwnedHostExtensions(original,{...options.extensions,
  modelTools:()=>{if(!surface)throw Error('Owned model surface unavailable');return surface.modelToolSchemas()},
  bindIdentity(owner,identity){const unbind=options.bindings.bind(owner,identity);try{original.retain(unbind)}catch(error){unbind();throw error}},
 })
 original.assertCurrent()
 surface=await createOwnedDefaultSurface(original,{...options.surface,
  prepareInput:text=>extensions.mount.expand(text),skillsPrompt:()=>extensions.catalog.skillsSection(),
 })
 original.assertCurrent()
 return surface
}
