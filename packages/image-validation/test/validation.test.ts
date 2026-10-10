import { expect, it } from 'vitest'
import { InvalidImageError, validateImage } from '../src/index.ts'
import { PNG, JPEG, GIF, WEBP } from './fixtures.ts'
import { crc32 } from 'node:zlib'
import sharp from 'sharp'

it.each([['png', PNG], ['jpeg', JPEG], ['gif', GIF], ['webp', WEBP]])('fully decodes genuine %s bytes without changing input', async (format, dataBase64) => {
  const image = { mediaType: `image/${format}`, dataBase64 }, original = JSON.stringify(image)
  expect(await validateImage(image)).toEqual({ width: 2, height: 2, frames: 1 })
  expect(JSON.stringify(image)).toBe(original)
})
it('rejects the exact malformed PNG and CRC-only corruption', async () => {
  const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  await expect(validateImage({ mediaType: 'image/png', dataBase64 })).rejects.toThrow(/checksum/)
  const bytes = Buffer.from(PNG, 'base64'); bytes[29] ^= 1
  await expect(validateImage({ mediaType: 'image/png', dataBase64: bytes.toString('base64') })).rejects.toBeInstanceOf(InvalidImageError)
})
it.each([null, {}, {mediaType:'image/png',dataBase64:''}, {mediaType:'image/png',dataBase64:'YR=='}, {mediaType:'image/jpeg',dataBase64:PNG}, {mediaType:'image/png',dataBase64:PNG.slice(0,-8)}])('rejects malformed envelopes and truncated images', async value => {
  await expect(validateImage(value)).rejects.toBeInstanceOf(InvalidImageError)
})
it('preserves cancellation as an abort, never classifies it as corrupt pixels', async () => {
  const controller = new AbortController(); controller.abort(new Error('caller stopped'))
  await expect(validateImage({ mediaType: 'image/png', dataBase64: PNG }, { signal: controller.signal })).rejects.toThrow('caller stopped')
})
it.each([['jpeg',JPEG],['gif',GIF],['webp',WEBP]])('rejects truncated %s pixel data', async (format,source) => {
  const bytes=Buffer.from(source,'base64')
  await expect(validateImage({mediaType:`image/${format}`,dataBase64:bytes.subarray(0,Math.floor(bytes.length*.6)).toString('base64')})).rejects.toBeInstanceOf(InvalidImageError)
})
it('rejects excessive PNG dimensions even with a valid header checksum', async () => {
  const bytes=Buffer.from(PNG,'base64')
  bytes.writeUInt32BE(9000,16);bytes.writeUInt32BE(crc32(bytes.subarray(12,29)),29)
  await expect(validateImage({mediaType:'image/png',dataBase64:bytes.toString('base64')})).rejects.toBeInstanceOf(InvalidImageError)
})
it('stops an in-flight native decode and allows retry without caching cancellation', async () => {
  const dataBase64=(await sharp({create:{width:11,height:13,channels:4,background:'red'}}).png().toBuffer()).toString('base64')
  const controller=new AbortController()
  const pending=validateImage({mediaType:'image/png',dataBase64},{signal:controller.signal})
  const timer=setTimeout(()=>controller.abort(new Error('human cancelled decode')),10)
  await expect(pending).rejects.toThrow('human cancelled decode')
  clearTimeout(timer)
  expect(await validateImage({mediaType:'image/png',dataBase64})).toMatchObject({width:11,height:13})
})
it.each(['gif','webp'] as const)('validates all frames of an animated %s without flattening its bytes', async format => {
  const pixels=Buffer.alloc(32)
  for(let p=0;p<8;p++){pixels[p*4+(p<4?0:2)]=255;pixels[p*4+3]=255}
  const bytes=await sharp(pixels,{raw:{width:2,height:4,channels:4,pageHeight:2}}).toFormat(format).toBuffer()
  const image={mediaType:`image/${format}`,dataBase64:bytes.toString('base64')}
  expect(await validateImage(image)).toEqual({width:2,height:2,frames:2})
  expect(Buffer.from(image.dataBase64,'base64')).toEqual(bytes)
  await expect(validateImage({...image,dataBase64:bytes.subarray(0,Math.floor(bytes.length*.7)).toString('base64')})).rejects.toBeInstanceOf(InvalidImageError)
})
