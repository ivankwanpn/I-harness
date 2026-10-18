import { createNondurableFactOwner, isNondurableSession, isManagedFactOwner, type FactOwner } from '@i-harness/core-session'
import type { CodeModeMountOptions } from './types.ts'

export function codeModeFactOwner(options: CodeModeMountOptions): FactOwner {
  const owner = options.factOwner ?? (isNondurableSession(options.session) ? createNondurableFactOwner(options.session) : undefined)
  if (!owner || owner.view !== options.session || !isNondurableSession(options.session) && !isManagedFactOwner(options.session, owner)) {
    throw Object.assign(new Error('Code Mode requires matching owned fact ports'), { code: 'FACT_OWNER_UNSUPPORTED' })
  }
  return owner
}
