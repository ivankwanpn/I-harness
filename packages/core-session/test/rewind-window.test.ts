import { expect, it } from "vitest"
import { rewindWindowCovers } from "../src/projection/rewind.ts"

const window = { cutFrom: 5, markerSeq: 12 }

it("compares the fact's seq with the window's seq bounds", () => {
  expect(rewindWindowCovers(window, 5)).toBe(true)
  expect(rewindWindowCovers(window, 11)).toBe(true)
  expect(rewindWindowCovers(window, 4)).toBe(false)
  expect(rewindWindowCovers(window, 12)).toBe(false)
  expect(rewindWindowCovers(window, undefined)).toBe(false)
})

it("covers a fact whose array index and seq disagree", () => {
  // A repaired/synthetic log can put seq 6 at array index 0. Using the index
  // (0 < cutFrom 5) would have hidden the wrong fact; the seq is covered.
  expect(rewindWindowCovers(window, 6)).toBe(true)
})
