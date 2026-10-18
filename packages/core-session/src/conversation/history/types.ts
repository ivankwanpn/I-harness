import type { ItemBuilder } from '../exchange.ts'

export interface HistoryRecipe {
  readonly kind: 'input' | 'summary' | 'assistant' | 'result' | 'images'
  readonly index?: number
  readonly calls?: readonly number[]
}
/** Derived structure references owned archive coordinates, never event bodies. */
export interface HistoryItem extends Omit<ItemBuilder, 'messages'> {
  readonly unit?: import('../legacy.ts').LegacyStep
  readonly establishmentIndex: number
  readonly admissionIndex?: number
  readonly imageAdmissionIndex?: number
  recipes: HistoryRecipe[]
}
