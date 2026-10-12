import { expect, it } from "vitest"
import { normalizeSettings } from "../src/index.ts"
it.each([undefined, -1, 29, 3601, 1.5, "30", NaN])("defaults invalid wait %s independently", value => {
 expect(normalizeSettings({ modelWait: { firstResponseSeconds: value, progressSeconds: 0 } }).modelWait).toEqual({ firstResponseSeconds: 300, progressSeconds: 0 })
})
it.each([0, 30, 300, 3600])("keeps valid wait %s", value => {
 expect(normalizeSettings({ modelWait: { firstResponseSeconds: value, progressSeconds: value } }).modelWait).toEqual({ firstResponseSeconds: value, progressSeconds: value })
})
