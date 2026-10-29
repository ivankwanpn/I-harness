import { expect, it } from 'vitest'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'

it('validates literal v1 and v2 task documents without migration or mutation', () => {
  for (const formatVersion of [1, 2]) {
    const value = Object.freeze({ formatVersion, tasks: Object.freeze([]), notifications: Object.freeze([]) })
    expect(() => taskDocumentStorageContract.validate(value)).not.toThrow()
    expect(value.formatVersion).toBe(formatVersion)
  }
  for (const value of [null, {}, { formatVersion: 3, tasks: [], notifications: [] }, { formatVersion: 2, tasks: {}, notifications: [] }])
    expect(() => taskDocumentStorageContract.validate(value)).toThrow()
})
