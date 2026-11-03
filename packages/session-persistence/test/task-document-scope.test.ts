import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnership } from '../src/coordinator/ownership.ts'
import * as publicApi from '../src/index.ts'

it('issues a nominal scope only under a real pin and synthetic operation admission', async () => {
  const { issueHeldTaskDocumentScope, isHeldTaskDocumentScope } = await import('../src/coordinator/task-document-scope.ts')
  const root = await mkdtemp(join(tmpdir(), 'ih-scope-'))
  const owner = createOwnership({ lockRoot: root }, { lock: { enabled: true } })
  const foreign = createOwnership({ lockRoot: root }, { lock: { enabled: true } })
  const claim = await owner.pinOwnership('parent-1')
  let revoked = false
  const admission = { assertActive() { if (this !== admission) throw new Error('wrong admission receiver'); if (revoked) throw false } }
  try {
    const scope = issueHeldTaskDocumentScope(owner, 'parent-1', claim, admission)
    expect(Object.isFrozen(scope)).toBe(true)
    expect(scope.parentSessionId).toBe('parent-1')
    expect(scope.key).toBe('task-parent-1')
    expect(() => { (scope as { key: string }).key = 'other' }).toThrow()
    expect(isHeldTaskDocumentScope(JSON.parse(JSON.stringify(scope)))).toBe(false)
    expect(isHeldTaskDocumentScope(scope)).toBe(true)
    for (const invalid of [{ ...scope }, new Proxy(scope, {}), { parentSessionId: 'parent-1', key: 'task-parent-1', assertActive() {} }, null]) expect(isHeldTaskDocumentScope(invalid)).toBe(false)
    expect(() => issueHeldTaskDocumentScope(foreign, 'parent-1', claim, admission)).toThrow()
    expect(() => issueHeldTaskDocumentScope(owner, 'other', claim, admission)).toThrow()
    expect(() => scope.assertActive.call({})).toThrow()
    scope.assertActive()
    const original = admission.assertActive
    admission.assertActive = () => {}
    expect(() => scope.assertActive()).toThrow()
    admission.assertActive = original
    Object.defineProperty(admission, 'assertActive', { configurable: true, get: () => original })
    expect(() => scope.assertActive()).toThrow()
    expect(() => issueHeldTaskDocumentScope(owner, 'parent-1', claim, admission)).toThrow()
    Object.defineProperty(admission, 'assertActive', { configurable: true, writable: true, value: original })
    expect(() => issueHeldTaskDocumentScope(owner, 'parent-1', claim, new Proxy(admission, {}))).toThrow()
    revoked = true
    try { scope.assertActive(); expect.fail('expected false rejection') } catch (error) { expect(error).toBe(false) }
    revoked = false
    await claim.release()
    expect(() => scope.assertActive()).toThrow()
    expect('issueHeldTaskDocumentScope' in publicApi).toBe(false)
    expect(publicApi.isHeldTaskDocumentScope(scope)).toBe(true)
  } finally { await claim.release(); await rm(root, { recursive: true, force: true }) }
})

it('captures only the original active queue turn and expires it on exit', async () => {
  const owner = createOwnership({}, { lock: { enabled: false } })
  expect(() => owner.captureActiveSessionOperation('p')).toThrow()
  let original: ReturnType<typeof owner.captureActiveSessionOperation> | undefined
  await owner.withSessionOperation('p', async () => {
    original = owner.captureActiveSessionOperation('p'); original.assertCurrent()
    expect(() => owner.captureActiveSessionOperation('other')).toThrow()
    expect(() => original!.assertCurrent.call({})).toThrow()
    await owner.withSessionOperation('other', async () => original!.assertCurrent())
  })
  expect(() => original!.assertCurrent()).toThrow()
  await owner.withSessionOperation('p', async () => { expect(() => original!.assertCurrent()).toThrow() })
})
