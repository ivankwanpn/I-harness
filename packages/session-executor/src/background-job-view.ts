import type { BackgroundJobView, NativeJobIdentity } from '@i-harness/exec'

export interface SessionBackgroundJob {
  id: string
  kind: 'shell' | 'workflow'
  status: BackgroundJobView['status']
  output: string
  outputTruncated: boolean
  ownerSessionId?: string
  nativeJob?: NativeJobIdentity
}

function preview(stdout: string, stderr: string) {
  const first = stdout.slice(0, 131072)
  return {
    output: first + stderr.slice(0, 131072 - first.length),
    outputTruncated: stdout.length + stderr.length > 131072,
  }
}

export function projectSessionBackgroundJobs(
  shell: readonly BackgroundJobView[],
  workflow: readonly BackgroundJobView[],
  sessionId: string | undefined,
): SessionBackgroundJob[] {
  return [
    ...shell.map(job => {
      const output = preview(job.stdout, job.stderr)
      return {
        id: job.id, kind: 'shell' as const, status: job.status, ...output,
        outputTruncated: output.outputTruncated || !!job.truncated?.stdout || !!job.truncated?.stderr,
        ownerSessionId: job.owner, nativeJob: job.nativeJob,
      }
    }),
    ...workflow.filter(job => job.owner === sessionId).map(job => ({
      id: job.id, kind: 'workflow' as const, status: job.status,
      ...preview(job.stdout, job.stderr), ownerSessionId: job.owner,
    })),
  ]
}
