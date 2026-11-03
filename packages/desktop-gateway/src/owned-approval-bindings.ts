import type { OwnedApprovalOwner } from './approval-rules.ts'

/** Identity callbacks are scoped to the exact owner handed to attachOwned. */
export function createOwnedApprovalBindings() {
 const bindings = new WeakMap<OwnedApprovalOwner, () => {workspaceId:string;revision:string}|undefined>()
 return Object.freeze({
  bind(owner:OwnedApprovalOwner, identity:()=>{workspaceId:string;revision:string}|undefined) {
   if(bindings.has(owner)) throw Error('Owned approval identity already bound')
   bindings.set(owner,identity)
   return () => { if(bindings.get(owner)===identity) bindings.delete(owner) }
  },
  identity(owner:OwnedApprovalOwner) { return bindings.get(owner)?.() },
 })
}
