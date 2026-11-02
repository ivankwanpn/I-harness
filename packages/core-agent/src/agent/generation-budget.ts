import type { GenerationPurpose } from '@i-harness/core-session'
import { generationError } from '@i-harness/llm-seam'

/** The original generation window is captured before durable child binding. */
export function captureGenerationBudget(purpose: GenerationPurpose, options: { timeoutMs?: number; maxAttempts?: number }, startedAt: number) {
  if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<=0))throw generationError('GENERATION_CLOCK_INVALID')
  if(options.maxAttempts!==undefined&&(!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<=0))throw new TypeError('Invalid generation attempt limit')
  const timeoutMs=options.timeoutMs??(purpose==='main'||purpose==='manual'?3_600_000:purpose==='title'?30_000:90_000)
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||!Number.isSafeInteger(startedAt+timeoutMs))throw generationError('GENERATION_CLOCK_INVALID')
  return Object.freeze({startedAt,expiresAt:startedAt+timeoutMs,timeoutMs,...options.maxAttempts!==undefined?{maxAttempts:options.maxAttempts}:{}})
}
