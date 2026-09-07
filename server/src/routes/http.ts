// 路由共享的 HTTP 助手（独立成模块：api.ts 聚合各子路由，子路由若反向 import api.ts 即成环）

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

/** POST JSON body：解析失败按 {} 处理（各 handler 自行做字段校验） */
export async function readJsonBody<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T
}
