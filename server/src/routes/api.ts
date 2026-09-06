// REST 路由聚合：子路由按原 handleApi 的检查顺序串联，首个命中者胜出。
// 各路径互不相同（无重叠前缀匹配），顺序仅作可读性保留。

import { handleMiscRoutes } from './misc'
import { handlePushRoutes } from './pushRoutes'
import { handleSessionRoutes } from './sessions'

export async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
  return (
    (await handlePushRoutes(req, url)) ??
    (await handleSessionRoutes(req, url)) ??
    (await handleMiscRoutes(req, url))
  )
}
