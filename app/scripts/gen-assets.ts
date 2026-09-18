// 从 web/src/assets/anyplane.svg（A/P ambigram，currentColor）生成 @capacitor/assets
// 所需的源素材：icon-only（1024 底+标）、icon-foreground（透明底标）、icon-background
// （同色底）、splash / splash-dark（2732 底 + 居中标）。色值取 index.css 暗色主题
// --bg/--ink。执行：bun scripts/gen-assets.ts（app/ 目录下）
import { readFileSync } from 'node:fs'
import sharp from 'sharp'

const SRC = '../web/src/assets/anyplane.svg'
const BG = '#0b0b0e' // --bg（暗色）
const INK = '#f2f2f4' // --ink（暗色）
const OUT = 'assets'

const svg = readFileSync(SRC, 'utf8').replaceAll('currentColor', INK)

/** 以高 density 栅格化 SVG 并缩放到目标边长（保持锐度） */
function markPng(size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer()
}

// 启动图标：标占约 65%（320 viewBox 自带 10% 内边距，观感约 58%）
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .composite([{ input: await markPng(665), gravity: 'center' }])
  .png()
  .toFile(`${OUT}/icon-only.png`)

// 自适应前景：标约 60% 居中于透明画布（66% 安全区内）
await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: await markPng(615), gravity: 'center' }])
  .png()
  .toFile(`${OUT}/icon-foreground.png`)

await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .png()
  .toFile(`${OUT}/icon-background.png`)

const splashMark = await markPng(640)
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } })
    .composite([{ input: splashMark, gravity: 'center' }])
    .png()
    .toFile(`${OUT}/${name}`)
}
console.log('素材就绪（源：anyplane.svg）')
