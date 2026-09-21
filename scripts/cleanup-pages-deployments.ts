#!/usr/bin/env bun
// Cloudflare Pages 部署清理：保留每类环境最近 N 个部署，其余经 API 删除。
// 背景：CF 不自动回收部署，堆积超 ~100 后项目本身无法删除（错误码 8000076，
// workers-sdk#12780）；dashboard 不支持批量删，只能走 API。
// 用法：bun run scripts/cleanup-pages-deployments.ts [--dry]
// 环境变量：
//   CLOUDFLARE_ACCOUNT_ID  （必填）账户 ID
//   CLOUDFLARE_API_TOKEN   （必填）需 Pages:Edit 权限
//   PAGES_PROJECT          （默认 anyplane）
//   KEEP_PRODUCTION        （默认 10）生产部署保留数——它们是唯一合法的回滚目标
//   KEEP_PREVIEW           （默认 3）预览部署保留数
// 安全红线：永不删除最新一个生产部署（它正服务于正式域名），与 KEEP_PRODUCTION 取值无关。

export {}

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
// 可选项一律用 || 而非 ??：GitHub Actions 的 env 对未配置变量注入的是空字符串而非 undefined，
// '' ?? default 会拿到空串（曾导致 PAGES_PROJECT='' → API 404 Project not found）。
const PROJECT = process.env.PAGES_PROJECT || 'anyplane'
const KEEP_PRODUCTION = Number(process.env.KEEP_PRODUCTION || 10)
const KEEP_PREVIEW = Number(process.env.KEEP_PREVIEW || 3)
const DRY_RUN = process.argv.includes('--dry') || process.env.DRY_RUN === '1'

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 环境变量')
  process.exit(1)
}
// Number('abc')=NaN 会绕过 < 1 比较（NaN 比较恒 false），且 slice(NaN)=slice(0) 等于全量标记删除
// ——保留数必须是整数，否则 fail fast，绝不带病运行。
if (!Number.isInteger(KEEP_PRODUCTION) || KEEP_PRODUCTION < 1 || !Number.isInteger(KEEP_PREVIEW) || KEEP_PREVIEW < 0) {
  console.error('KEEP_PRODUCTION 必须是 >= 1 的整数，KEEP_PREVIEW 必须是 >= 0 的整数')
  process.exit(1)
}

interface Deployment {
  id: string
  url: string
  environment: 'production' | 'preview'
  created_on: string
  latest_stage?: { name?: string; status?: string }
}

// CF_API_BASE 仅测试用（默认官方 API，mock 时覆盖）。
const API = `${process.env.CF_API_BASE ?? `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`}/pages/projects/${PROJECT}/deployments`
const headers = { Authorization: `Bearer ${API_TOKEN}` }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers, ...init })
  const body = (await res.json()) as { success: boolean; errors?: { message: string }[]; result: T }
  if (!res.ok || !body.success) {
    throw new Error(`CF API ${init?.method ?? 'GET'} ${path} 失败（HTTP ${res.status}）: ${JSON.stringify(body.errors)}`)
  }
  return body.result
}

/** 翻页拉全量部署（列表接口每页最多 25 条）。 */
async function listAll(): Promise<Deployment[]> {
  const all: Deployment[] = []
  for (let page = 1; ; page++) {
    const batch = await api<Deployment[]>(`?per_page=25&page=${page}`)
    all.push(...batch)
    if (batch.length < 25) return all
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const deployments = await listAll()
console.log(`项目 ${PROJECT} 共 ${deployments.length} 个部署`)

// 分桶：按环境分组、组内按创建时间降序（新→旧）
const byEnv = { production: [] as Deployment[], preview: [] as Deployment[] }
for (const d of deployments) byEnv[d.environment]?.push(d)
for (const list of Object.values(byEnv)) list.sort((a, b) => b.created_on.localeCompare(a.created_on))

const keepOf = { production: KEEP_PRODUCTION, preview: KEEP_PREVIEW }
const doomed: Deployment[] = []
for (const [env, list] of Object.entries(byEnv) as [keyof typeof byEnv, Deployment[]][]) {
  const excess = list.slice(keepOf[env])
  // 红线：正服务线上域名的是「最近一个构建成功的部署」——构建失败的生产部署不占流量，
  // 若只按 created_on 保护 list[0]，失败部署堆积超保留数后真正 serving 的会被删（线上 404）。
  // latest_stage 缺失（旧数据）视为未知，保守参与保护兜底
  const serving = list.find((d) => d.latest_stage?.status !== 'failure') ?? list[0]
  // 红线过滤后的真实删除集才进日志——否则红线生效时「待删」会比实际删除数虚高
  const doomedInEnv = excess.filter((d) => !(env === 'production' && d === serving))
  doomed.push(...doomedInEnv)
  console.log(`${env}: 共 ${list.length} 个，保留 ${Math.min(keepOf[env], list.length)} 个，待删 ${doomedInEnv.length} 个`)
}

if (doomed.length === 0) {
  console.log('无需清理')
  process.exit(0)
}

for (const d of doomed) {
  const label = `${d.environment} ${d.created_on} ${d.url}`
  if (DRY_RUN) {
    console.log(`[dry-run] 将删除 ${label}`)
    continue
  }
  await api(`/${d.id}?force=true`, { method: 'DELETE' })
  console.log(`已删除 ${label}`)
  await sleep(150) // CF API 限流 1200 req/5min，删除节流避免贴线
}

console.log(DRY_RUN ? `dry-run 结束：${doomed.length} 个部署将被删除` : `清理完成：删除 ${doomed.length} 个部署`)
