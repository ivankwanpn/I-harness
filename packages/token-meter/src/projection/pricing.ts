import { estimateUtf8Text } from '../text-density.ts'

// Prepared protocol estimates use the projected-pricing-v2 ASCII density.
export function priceProjectedText(text: string): number {
  return estimateUtf8Text(text, 3)
}

/** The projection records the UTF-8 length alongside its token estimate. */
export function priceProjectedBytes(text: string, utf8Bytes: number): number {
  return estimateUtf8Text(text, 3, utf8Bytes)
}
