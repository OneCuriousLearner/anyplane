import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { basename } from 'node:path'
import { MAX_IMAGE_BASE64, resolveUpload, saveUpload } from './uploads'

// 1x1 透明 PNG（43 字节）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const savedPaths: string[] = []

afterAll(() => {
  for (const p of savedPaths) rmSync(p, { force: true })
})

describe('saveUpload 校验', () => {
  test('不支持的类型拒绝', () => {
    expect(() => saveUpload({ name: 'x', mediaType: 'image/svg+xml', dataBase64: PNG_B64 })).toThrow('不支持的图片类型')
    expect(() => saveUpload({ name: 'x', mediaType: 'text/html', dataBase64: PNG_B64 })).toThrow('不支持的图片类型')
  })

  test('超过 5MB base64 限制拒绝', () => {
    const big = 'A'.repeat(MAX_IMAGE_BASE64 + 1)
    expect(() => saveUpload({ name: 'x', mediaType: 'image/png', dataBase64: big })).toThrow('超过 5MB 限制')
  })

  test('空内容拒绝', () => {
    expect(() => saveUpload({ name: 'x', mediaType: 'image/png', dataBase64: '' })).toThrow('图片内容为空')
  })
})

describe('saveUpload → resolveUpload 往返', () => {
  test('hash 命名落盘，同内容重复保存幂等去重', () => {
    const p1 = saveUpload({ name: 'a.png', mediaType: 'image/png', dataBase64: PNG_B64 })
    savedPaths.push(p1)
    expect(basename(p1)).toMatch(/^[0-9a-f]{16}\.png$/)

    // 同名同内容不报错、不另存（hash 去重）
    const p2 = saveUpload({ name: 'b.png', mediaType: 'image/png', dataBase64: PNG_B64 })
    expect(p2).toBe(p1)

    expect(resolveUpload(basename(p1))).toBe(p1)
  })
})

describe('resolveUpload 边界（/api/uploads/<file> 的路径闸）', () => {
  test('只接受 16 位 hex + 图片扩展名，遍历/注入一律 null', () => {
    expect(resolveUpload('../config.json')).toBeNull()
    expect(resolveUpload('..%2f..%2fvapid.json')).toBeNull()
    expect(resolveUpload('abcdef0123456789.png/evil')).toBeNull()
    expect(resolveUpload('abcdef0123456789.exe')).toBeNull()
    expect(resolveUpload('abcdef0123456789.PNG')).toBeNull() // 大小写敏感，与 saveUpload 产物一致
    expect(resolveUpload('abcdef012345678')).toBeNull() // 15 位不够
    expect(resolveUpload('ghijkl0123456789.png')).toBeNull() // 非 hex 字符
    expect(resolveUpload('')).toBeNull()
  })

  test('形状合法但文件不存在 → null', () => {
    expect(resolveUpload('0000000000000000.png')).toBeNull()
  })
})
