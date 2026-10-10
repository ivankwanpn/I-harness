// Bytes only, one bounded decode, no paths/URLs/provider credentials.
process.once('message', async ({ bytes, mime, frames: expectedFrames }) => {
  let sharp
  try { sharp = (await import('sharp')).default }
  catch { process.send?.({ unavailable: 'native decoder could not load' }); return }
  sharp.cache(false)
  sharp.concurrency(1)
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 32 * 1024 * 1024, animated: true })
    const metadata = await decoder.metadata()
    const width = metadata.width, height = metadata.pageHeight ?? metadata.height, frames = metadata.pages ?? 1
    if (expectedFrames !== undefined && frames !== expectedFrames) throw new Error('decoder skipped GIF frames')
    if (`image/${metadata.format === 'jpg' ? 'jpeg' : metadata.format}` !== mime) throw new Error('decoded format differs from declared media type')
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024 || frames > 100 || width * height * frames > 32 * 1024 * 1024) throw new Error('image dimensions or animation exceed decode limits')
    await decoder.raw().toBuffer()
    process.send?.({ info: { width, height, frames } })
  } catch {
    // Decoder diagnostics may contain attacker-controlled metadata. Keep the error stable.
    process.send?.({ invalid: 'image cannot be fully decoded or exceeds dimension/frame limits' })
  }
})
