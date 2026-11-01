import { withDesktopSettings } from '../settings-file.ts'
export function createInstructionSettings(path: string) {
  return {
    state: () => withDesktopSettings(path, async store => ({ saved: store.get().instructions })),
    configure: (patch: unknown) => withDesktopSettings(path, async store => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['enabled', 'maxBytes', 'globalSources'].includes(key))) throw new Error('Invalid instruction settings patch')
      const proto = Object.getPrototypeOf(patch), descriptors = Object.getOwnPropertyDescriptors(patch)
      if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]!))) throw new Error('Invalid instruction settings patch')
      const value = { ...store.get().instructions, ...patch }
      await store.set({ instructions: value })
      return { saved: store.get().instructions }
    }),
  }
}
