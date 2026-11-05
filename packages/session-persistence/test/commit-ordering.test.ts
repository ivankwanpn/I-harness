import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureOriginalResultOrderingRegistration, beginOriginalResultOrderingRegistration } from '../src/result-ordering-internal.ts'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-order-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('commit-log result ordering', () => {
  it('issues and validates one ordering registration per ledger identity', async () => {
    const { coordinator } = await setup()
    const facade = asSessionCoordinator(coordinator)
    const registration = beginOriginalResultOrderingRegistration(facade as never, {})
    captureOriginalResultOrderingRegistration(facade as never, registration)
    registration.commit({} as never)
    expect(() => registration.commit({} as never)).toThrow(/expired/)
  })

  it('refuses a registration issued by a different coordinator', async () => {
    const { root, coordinator } = await setup()
    const facade = asSessionCoordinator(coordinator)
    const registration = beginOriginalResultOrderingRegistration(facade as never, {})
    const other = createCommitCoordinator({ root: join(root, 'other') })
    coordinators.push(other)
    const otherFacade = asSessionCoordinator(other)
    expect(() => captureOriginalResultOrderingRegistration(otherFacade as never, registration)).toThrow()
  })

  it('refuses ordering on a coordinator without the association', async () => {
    const { coordinator } = await setup()
    expect(() => beginOriginalResultOrderingRegistration(coordinator as never, {})).toThrow(/Original result ordering coordinator required/)
  })
})
