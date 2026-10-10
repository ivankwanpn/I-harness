import { createContext, useCallback, useContext, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"

// A renderer connection owns these drafts for its app session. Nothing is
// serialized: secret fields, revisions and original baselines stay in memory.
interface DraftStore { values: Map<string, unknown> }
const stores = new WeakMap<object, DraftStore>()
const DraftContext = createContext<DraftStore | undefined>(undefined)
function storeFor(owner: object): DraftStore {
  let store = stores.get(owner)
  if (!store) { store = { values: new Map() }; stores.set(owner, store) }
  return store
}
const keyFor = (identity: readonly string[]) => JSON.stringify(identity)

export function SettingsDraftScope({ owner, children }: { owner: object; children: ReactNode }) {
  const inherited = useContext(DraftContext)
  return <DraftContext.Provider value={inherited ?? storeFor(owner)}>{children}</DraftContext.Provider>
}

export interface ClearSettingsDraft<T> { (): boolean; (submittedSnapshot: T): boolean }

export function useSettingsDraft<T>(identity: readonly string[], initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>, ClearSettingsDraft<T>] {
  const inherited = useContext(DraftContext)
  const local = useRef<DraftStore>({ values: new Map() })
  const store = inherited ?? local.current
  const key = keyFor(identity)
  const read = () => {
    if (store.values.has(key)) return store.values.get(key) as T
    const value = typeof initial === "function" ? (initial as () => T)() : initial
    store.values.set(key, value)
    return value
  }
  const [snapshot, setSnapshot] = useState(() => ({ key, value: read() }))
  const value = snapshot.key === key ? snapshot.value : read()
  const latest = useRef({ key, value })
  latest.current = { key, value }
  const set: Dispatch<SetStateAction<T>> = useCallback(next => {
    const previous = store.values.has(key) ? store.values.get(key) as T : read()
    const value = typeof next === "function" ? (next as (previous: T) => T)(previous) : next
    store.values.set(key, value)
    if (latest.current.key === key) { latest.current = { key, value }; setSnapshot({ key, value }) }
  }, [store, key])
  const clear: ClearSettingsDraft<T> = useCallback((...submitted: [] | [T]) => {
    if (submitted.length && !Object.is(store.values.get(key), submitted[0])) return false
    return store.values.delete(key)
  }, [store, key])
  return [value, set, clear]
}

export function useSettingsDraftMap<T>(identity: readonly string[]): Map<string, T> {
  const inherited = useContext(DraftContext)
  const local = useRef<DraftStore>({ values: new Map() })
  const store = inherited ?? local.current
  const key = keyFor(identity)
  let value = store.values.get(key) as Map<string, T> | undefined
  if (!value) { value = new Map(); store.values.set(key, value) }
  return value
}
