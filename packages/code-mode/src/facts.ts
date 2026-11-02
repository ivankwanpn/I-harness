import { types } from 'node:util'
import { createNondurableFactOwner, isNondurableSession, isManagedFactOwner, type FactOwner } from '@i-harness/core-session'
import { isManagedExecutionDomain, isManagedExecutionOwner, type ManagedExecutionOwner } from '@i-harness/core-session/internal/execution'
import { isManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import type { PluginContext } from '@i-harness/core-plugin'
import type { CodeModeMountOptions } from './types.ts'

export type CodeModeFactOwner = FactOwner | ManagedExecutionOwner
export function codeModeFactOwner(options: CodeModeMountOptions, ctx:PluginContext): CodeModeFactOwner {
  if(!options||types.isProxy(options))throw TypeError('Original Code mount options required')
  const kind=Object.getOwnPropertyDescriptor(options,'kind');if(kind&&!('value'in kind))throw TypeError('Original Code mount options required')
  if(kind?.value==='managed-execution') {
    if(types.isProxy(options)||Reflect.ownKeys(options).some(key=>typeof key!=='string'||!['kind','execution','domain','sessionId','config','retainText','finalOutput','flush','maxParallel'].includes(key)))throw TypeError('Closed private Code mount required')
    const fields=Object.getOwnPropertyDescriptors(options);if(Object.values(fields).some(field=>!('value'in field)||!field.enumerable))throw TypeError('Closed private Code mount required')
    const {execution,domain,sessionId}=options as Extract<CodeModeMountOptions,{kind:'managed-execution'}>
    if(!isManagedExecutionAttachment(execution)||!isManagedExecutionOwner(execution.identity,execution.owner)||!isManagedExecutionDomain(domain,ctx)||domain.identity!==execution.identity||domain.owner!==execution.owner||domain.sessionId!==sessionId) throw TypeError('Original private Code execution required')
    domain.assertCurrent();return execution.owner
  }
  if(options.kind==='managed-execution')throw TypeError('Invalid private Code mount')
  const owner = options.factOwner ?? (isNondurableSession(options.session) ? createNondurableFactOwner(options.session) : undefined)
  if (!owner || owner.view !== options.session || !isNondurableSession(options.session) && !isManagedFactOwner(options.session, owner)) {
    throw Object.assign(new Error('Code Mode requires matching owned fact ports'), { code: 'FACT_OWNER_UNSUPPORTED' })
  }
  return owner
}
