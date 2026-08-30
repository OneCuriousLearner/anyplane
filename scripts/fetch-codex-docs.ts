#!/usr/bin/env bun
/**
 * 从 https://learn.chatgpt.com 拉取官方 Codex / ChatGPT 文档镜像到 docs/codex/（已 gitignore）。
 * 来源：llms.txt 索引 + /docs/*.md 各页 + llms-full.txt 整包。
 *
 * 与 docs:claude 同一套路。learn.chatgpt.com 是 OpenAI 第一方产品文档；
 * developers.openai.com/codex/llms.txt 目前指向同一份索引，不再重复拉取。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const BASE = 'https://learn.chatgpt.com'
const OUT = join(import.meta.dir, '..', 'docs', 'codex')
const CONCURRENCY = 8

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  const ct = res.headers.get('content-type') ?? ''
  const body = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`)
  if (ct.includes('text/html') || /^\s*<(!DOCTYPE|html)/i.test(body)) {
    throw new Error(`got HTML instead of markdown: ${url}`)
  }
  return body
}

function extractMdUrls(llmsTxt: string): string[] {
  const urls = new Set<string>()
  for (const m of llmsTxt.matchAll(/\((https:\/\/learn\.chatgpt\.com\/[^)\s]+)\)/g)) {
    const u = new URL(m[1]!)
    u.search = ''
    u.hash = ''
    // 只收 /docs/*.md：根路径 docs.md / resources.md / videos.md 与 /guides/*.md 现为 404
    if (!u.pathname.startsWith('/docs/')) continue
    if (!u.pathname.endsWith('.md')) continue
    urls.add(u.toString())
  }
  return [...urls].sort()
}

function localPathFor(url: string): string {
  const u = new URL(url)
  // /docs/foo.md → docs/foo.md
  return join(OUT, u.pathname.replace(/^\//, ''))
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<{ ok: number; fail: { item: T; err: string }[] }> {
  let ok = 0
  const fail: { item: T; err: string }[] = []
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        await fn(items[i]!, i)
        ok++
      } catch (e) {
        fail.push({ item: items[i]!, err: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return { ok, fail }
}

async function main() {
  await mkdir(OUT, { recursive: true })

  console.log('fetch llms.txt …')
  const llmsTxt = await fetchText(`${BASE}/llms.txt`)
  await writeFile(join(OUT, 'llms.txt'), llmsTxt, 'utf8')

  console.log('fetch llms-full.txt …')
  const llmsFull = await fetchText(`${BASE}/docs/llms-full.txt`)
  await writeFile(join(OUT, 'llms-full.txt'), llmsFull, 'utf8')

  const urls = extractMdUrls(llmsTxt)
  console.log(`fetch ${urls.length} markdown pages (concurrency=${CONCURRENCY}) …`)

  const { ok, fail } = await mapPool(urls, CONCURRENCY, async (url) => {
    const dest = localPathFor(url)
    await mkdir(dirname(dest), { recursive: true })
    const body = await fetchText(url)
    if (!body.trim()) throw new Error('empty body')
    await writeFile(dest, body, 'utf8')
    process.stdout.write('.')
  })
  process.stdout.write('\n')

  const manifest = {
    fetchedAt: new Date().toISOString(),
    source: BASE,
    llmsTxtBytes: Buffer.byteLength(llmsTxt),
    llmsFullBytes: Buffer.byteLength(llmsFull),
    pagesTotal: urls.length,
    pagesOk: ok,
    pagesFail: fail.map((f) => ({ url: f.item, err: f.err })),
  }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(
    `done → ${relative(process.cwd(), OUT)} | pages ${ok}/${urls.length}` +
      (fail.length ? ` | FAIL ${fail.length}` : ''),
  )
  if (fail.length) {
    for (const f of fail.slice(0, 20)) console.error(`  ${f.item}: ${f.err}`)
    if (fail.length > 20) console.error(`  … +${fail.length - 20} more`)
    process.exit(1)
  }

  const must = ['docs/app-server.md', 'docs/developer-commands.md', 'docs/non-interactive-mode.md']
  for (const rel of must) {
    const p = join(OUT, rel)
    const f = Bun.file(p)
    if (!(await f.exists()) || f.size < 100) {
      console.error(`verify failed: missing/too small ${rel}`)
      process.exit(1)
    }
  }
  if (llmsFull.length < 100_000) {
    console.error('verify failed: llms-full.txt unexpectedly small')
    process.exit(1)
  }
  console.log('verify ok')
}

await main()
