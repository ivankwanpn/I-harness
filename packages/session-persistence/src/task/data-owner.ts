/** One current installed Task data owner per original operation set/parent. */
type Owner = { data: object; retire(): Promise<void> }
const installedData = new WeakMap<object, Map<string, Owner>>()

export async function prepareOriginalTaskDataReplacement(operations: object, stateId: string, data: object) {
  const previous = installedData.get(operations)?.get(stateId)
  if (previous && previous.data !== data) await previous.retire()
  const expected = installedData.get(operations)?.get(stateId)
  if (expected && expected.data !== data) throw Error('Original Task owner retirement is incomplete')
  let installed = false
  const current = () => {
    const value = installedData.get(operations)?.get(stateId)
    if (installed ? value?.data !== data : value !== expected) throw Error('Original Task data owner changed during load')
  }
  const replacement = Object.freeze({
    assertCurrent() { if (this !== replacement) throw TypeError('Original Task replacement required'); current() },
    install(retire: () => Promise<void>) {
      if (this !== replacement || installed) throw TypeError('Original Task replacement required')
      current()
      let states = installedData.get(operations)
      if (!states) { states = new Map(); installedData.set(operations, states) }
      states.set(stateId, { data, retire }); installed = true
    },
  })
  return replacement
}

export function isInstalledRequiredTaskData(operations: object, stateId: string, data: object) {
  return installedData.get(operations)?.get(stateId)?.data === data
}

export function releaseOriginalTaskData(operations: object, stateId: string, data: object) {
  const states = installedData.get(operations)
  if (states?.get(stateId)?.data === data) states.delete(stateId)
}
