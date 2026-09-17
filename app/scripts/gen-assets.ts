// 从 web/public/icon-512.png 生成 @capacitor/assets 所需的源素材：
// icon-only（1024）、icon-foreground（660px 居中透明底）、icon-background（同色底）、
// splash / splash-dark（2732 底 + 居中图标）。执行：bun scripts/gen-assets.ts（app/ 目录下）
import sharp from 'sharp'

const SRC = '../web/public/icon-512.png'
const BG = '#0a0a0b'
const OUT = 'assets'

const icon = sharp(SRC)
const meta = await icon.metadata()
console.log(`源图 ${meta.width}x${meta.height} alpha=${meta.hasAlpha}`)

const tile1024 = await sharp(SRC).resize(1024).png().toBuffer()
await sharp(tile1024).toFile(`${OUT}/icon-only.png`)

// 自适应前景：整块图标缩到 660px 居中于透明画布——底色与 icon-background 同色，
// 遮罩后图标边缘与背景无缝融合，等效「星标居中缩到安全区」
const tile660 = await sharp(SRC).resize(660).png().toBuffer()
await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: tile660, gravity: 'center' }])
  .png()
  .toFile(`${OUT}/icon-foreground.png`)

await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .png()
  .toFile(`${OUT}/icon-background.png`)

const tile800 = await sharp(SRC).resize(800).png().toBuffer()
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } })
    .composite([{ input: tile800, gravity: 'center' }])
    .png()
    .toFile(`${OUT}/${name}`)
}
console.log('素材就绪')
