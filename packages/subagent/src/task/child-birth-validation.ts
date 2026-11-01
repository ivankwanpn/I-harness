import { captureChildBootstrapCaptureRequest, childInitialCommitment, compileSemanticSeed } from '@i-harness/session-persistence'
import type { TaskRecord } from './types.ts'

export function validateChildBirth(task: TaskRecord): void {
  const binding = task.childBirth!
  if (Object.keys(binding).sort().join(',') !== 'kind,request,version' || binding.version !== 1 || binding.kind !== 'task-child-birth' || task.legacyFormatVersion) throw new Error('Invalid task child birth')
  const request = captureChildBootstrapCaptureRequest(binding.request), { core, invocation } = request, caller = core.caller
  if (caller.kind !== 'task' || !task.parentSessionId || caller.taskId !== task.id || caller.parentSessionId !== task.parentSessionId || caller.callEventSeq !== task.callEventSeq || caller.toolCallId !== task.toolCallId || caller.callEventSeq === undefined && !caller.toolCallId || task.agent !== core.execution.roleName || task.childSessionId !== undefined && task.childSessionId !== invocation.targetSessionId || core.history.selection.kind !== 'none' && (core.history.selection.kind !== 'all' && (core.history.selection.kind !== 'last-turns' || !Number.isSafeInteger(core.history.selection.count) || core.history.selection.count <= 0) || !('source' in core.history) || core.history.source.kind !== 'session' || core.history.source.sessionId !== task.parentSessionId) || core.lineage.origin !== 'subagent' || core.lineage.subagentProtocolVersion !== 1 || core.execution.approval !== 'ordinary') throw new Error('Invalid task child birth identity')
  const initial = core.initial
  const actual = childInitialCommitment({invocation,target:{kind:'new'},metadata:core.metadata,lineage:core.lineage,seed:compileSemanticSeed({kind:'none'}),initial:{inputId:initial.inputId,text:task.prompt,startedAt:initial.startedAt,expiresAt:initial.expiresAt,...(initial.parentSessionId === undefined ? {} : {parentSessionId:initial.parentSessionId})}})
  if (actual.digest !== initial.digest || actual.parentSessionId !== task.parentSessionId) throw new Error('Invalid task child birth commitment')
}
