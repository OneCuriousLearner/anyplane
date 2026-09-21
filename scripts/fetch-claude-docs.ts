#!/usr/bin/env bun
/**
 * 从 https://code.claude.com/docs 拉取官方文档镜像到 docs/claude-code/（已 gitignore）。
 * 来源：llms.txt 索引 + 各页 .md + llms-full.txt 整包。
 */
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const BASE = 'https://code.claude.com/docs'
const OUT = join(import.meta.dir, '..', 'docs', 'claude-code')
const CONCURRENCY = 8

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`)
  return await res.text()
}

function extractMdUrls(llmsTxt: string): string[] {
  const urls = new Set<string>()
  for (const m of llmsTxt.matchAll(/\((https:\/\/code\.claude\.com\/docs\/[^)\s]+\.md)\)/g)) {
    urls.add(m[1]!)
  }
  return [...urls].sort()
}

function localPathFor(url: string): string {
  const u = new URL(url)
  // /docs/en/foo.md → en/foo.md
  const path = u.pathname.replace(/^\/docs\//, '')
  return join(OUT, path)
}

/** tmp+rename 原子替换：中断/Ctrl+C 不会留下半截 md 与「新索引+半新半旧页面」的混版镜像
 *（旧实现直接 writeFile 最终路径，docs 镜像会被当协议正本引用，混版静默污染依据） */
async function writeFileAtomic(dest: string, body: string): Promise<void> {
  const tmp = `${dest}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, dest)
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
  await writeFileAtomic(join(OUT, 'llms.txt'), llmsTxt)

  console.log('fetch llms-full.txt …')
  const llmsFull = await fetchText(`${BASE}/llms-full.txt`)
  await writeFileAtomic(join(OUT, 'llms-full.txt'), llmsFull)

  const urls = extractMdUrls(llmsTxt)
  console.log(`fetch ${urls.length} markdown pages (concurrency=${CONCURRENCY}) …`)

  const { ok, fail } = await mapPool(urls, CONCURRENCY, async (url) => {
    const dest = localPathFor(url)
    await mkdir(dirname(dest), { recursive: true })
    const body = await fetchText(url)
    if (!body.trim()) throw new Error('empty body')
    await writeFileAtomic(dest, body)
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
  await writeFileAtomic(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  // 上游已删除/改名的页面在本地无限期残留（索引不再指向它们）——prune 掉，
  // 否则陈旧页面会被后续开发当现行协议正本引用，静默漂移
  const wanted = new Set(urls.map((u) => localPathFor(u)))
  let pruned = 0
  async function walkPrune(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) await walkPrune(p)
      else if (entry.name.endsWith('.md') && !wanted.has(p)) {
        await rm(p, { force: true })
        pruned++
      }
    }
  }
  await walkPrune(OUT)
  if (pruned) console.log(`pruned ${pruned} stale pages`)

  console.log(
    `done → ${relative(process.cwd(), OUT)} | pages ${ok}/${urls.length}` +
      (fail.length ? ` | FAIL ${fail.length}` : ''),
  )
  if (fail.length) {
    for (const f of fail.slice(0, 20)) console.error(`  ${f.item}: ${f.err}`)
    if (fail.length > 20) console.error(`  … +${fail.length - 20} more`)
    process.exit(1)
  }

  // 基本校验：overview + cli-reference 必须存在且非空
  const must = ['en/overview.md', 'en/cli-reference.md']
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
