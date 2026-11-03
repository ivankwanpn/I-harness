import { expect, it } from 'vitest'
import { createOwnership } from '../src/coordinator/ownership.ts'

it('refuses same-session nested queue admission before it can wait on itself', async () => {
  const owner = createOwnership({})
  await owner.withSessionOperation('parent', async () => {
    expect(() => owner.assertOutsideSessionOperation('parent')).toThrow()
    expect(() => owner.assertOutsideSessionOperation('other')).not.toThrow()
    await owner.withSessionOperation('other', async () => expect(() => owner.assertOutsideSessionOperation('parent')).toThrow())
  })
  expect(() => owner.assertOutsideSessionOperation('parent')).not.toThrow()
})
