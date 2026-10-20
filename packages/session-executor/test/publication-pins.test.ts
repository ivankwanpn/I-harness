import assert from 'node:assert/strict'
import { it } from 'vitest'
import { launch } from './helpers/publication-launch.mts'
import { cuts } from './helpers/publication-native.mts'

// These controls catch replayed lowering, replacement operations, premature
// descriptors, lost original pins and incorrectly upgraded known refusals.
it('positively qualifies all ten original native transitions without faults', async () => {
  const fixture = await launch('control')
  try { await fixture.message('done'); await fixture.message('closed'); assert.deepEqual(await fixture.close, { code: 0, signal: null }) }
  finally { await fixture.cleanup() }
}, 30000)

it.each(cuts)('reconciles %s uncertainty through the same original capture', async cut => {
  const fixture = await launch('live', cut)
  try { await fixture.message('done'); await fixture.message('closed'); assert.deepEqual(await fixture.close, { code: 0, signal: null }) }
  finally { await fixture.cleanup() }
}, 30000)

it.each(['first-pin', 'first-access', 'second-pin', 'second-access'] as const)('releases actual coordinator documents after %s uncertainty and checks a retired-store fresh reader', async cut => {
  const fixture = await launch('delete', cut)
  try { await fixture.message('done'); await fixture.message('closed'); assert.deepEqual(await fixture.close, { code: 0, signal: null }) }
  finally { await fixture.cleanup() }
}, 30000)

it.each(['quota-commit', 'quota-second'] as const)('preserves operational outcome at real original %s refusal', async mode => {
  const fixture = await launch(mode)
  try { await fixture.message('done'); await fixture.message('closed'); assert.deepEqual(await fixture.close, { code: 0, signal: null }) }
  finally { await fixture.cleanup() }
}, 30000)

it('permanently closes the original component after uncertainty without reopening its scope', async () => {
  const fixture = await launch('closure', 'manifest-rename')
  try { await fixture.message('done'); await fixture.message('closed'); assert.deepEqual(await fixture.close, { code: 0, signal: null }) }
  finally { await fixture.cleanup() }
}, 30000)
