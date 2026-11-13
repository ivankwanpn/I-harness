import { expect, it } from 'vitest'
import { settleManagedJournalCleanup, type NativeJournalCleanup } from '../src/native-fact-writer-internal.ts'

it('returns synchronously without work when original journal cleanup has no debt', () => {
  let checks = 0
  const scope: NativeJournalCleanup = {
    hasDebt() { checks++; return false },
    async settle() { throw Error('A debt-free scope must not be settled') },
  }
  expect(settleManagedJournalCleanup(undefined)).toBeUndefined()
  expect(settleManagedJournalCleanup(new Map())).toBeUndefined()
  expect(settleManagedJournalCleanup(new Map([[{}, scope]]))).toBeUndefined()
  expect(checks).toBe(1)
})

it.each([undefined, false])('keeps original falsey classification failure as a rejected promise (%s)', async cause => {
  const scope: NativeJournalCleanup = {
    hasDebt() { throw cause },
    async settle() { throw Error('No cleanup was selected') },
  }
  let result: Promise<void> | undefined
  expect(() => { result = settleManagedJournalCleanup(new Map([[{}, scope]])) }).not.toThrow()
  expect(result).toBeInstanceOf(Promise)
  let rejected = false
  await result!.then(() => { throw Error('The original classification failure was lost') }, error => {
    rejected = true
    expect(error).toBe(cause)
  })
  expect(rejected).toBe(true)
})

it.each([undefined, false])('joins every selected original cleanup after a synchronous falsey failure (%s)', async cause => {
  const held = Promise.withResolvers<void>()
  let attempted = 0
  const failed: NativeJournalCleanup = {
    hasDebt() { return true },
    settle() { attempted++; throw cause },
  }
  const pending: NativeJournalCleanup = {
    hasDebt() { return true },
    settle() { attempted++; return held.promise },
  }
  const cleanup = settleManagedJournalCleanup(new Map([[{}, failed], [{}, pending]]))
  expect(cleanup).toBeInstanceOf(Promise)
  expect(attempted).toBe(2)
  let finished = false
  void cleanup!.then(() => { finished = true }, () => { finished = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  held.resolve()
  await expect(cleanup).rejects.toMatchObject({
    code: 'FACT_RECOVERY_REQUIRED',
    cause: { errors: [cause] },
  })
  expect(attempted).toBe(2)
})
