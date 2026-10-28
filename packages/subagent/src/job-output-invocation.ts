import type { Tool, ToolExec } from '@i-harness/core-tools'
import type { ReportPolicy } from './report-policy.ts'
export type JobOutputInvocation = (args: Record<string, unknown>, exec: ToolExec, policy: ReportPolicy) => Promise<{ route: 'native' | 'compat'; value: Record<string, unknown> }>
const invocations = new WeakMap<Tool, JobOutputInvocation>()
export function registerJobOutputInvocation(tool: Tool, invoke: JobOutputInvocation): void { invocations.set(tool, invoke) }
export function jobOutputInvocation(tool: Tool): JobOutputInvocation | undefined { return invocations.get(tool) }
