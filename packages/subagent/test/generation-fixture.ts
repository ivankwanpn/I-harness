import { beforeEach, vi } from 'vitest'
import type { DocumentGenerationFactory } from '@i-harness/core-agent'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
export { controlledModel } from '../../session-executor/test/controlled-model.ts'

// Test-only composition uses the actual document owner and real generation
// implementation. Built-in local mocks require this explicit selected policy;
// dynamic responses use the owned adapter's recording transport fixture.
export const fixtureGenerationFor: DocumentGenerationFactory = (owner, id, selected) => action =>
  createGenerationLifecycle(owner.view, id, action, { enabled: true, selectedClient: selected })
beforeEach(() => vi.stubGlobal('fetch', async () => { throw new Error('Unexpected network destination') }))
