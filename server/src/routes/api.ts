// REST 路由聚合：子路由按原 handleApi 的检查顺序串联，首个命中者胜出。
// 各路径互不相同（无重叠前缀匹配），顺序仅作可读性保留。

import { handleMiscRoutes } from './misc'
import { handlePushRoutes } from './pushRoutes'
import { handleSessionRoutes } from './sessions'

export type ApiRouteHandler = (req: Request, url: URL) => Promise<Response | undefined>

const defaultHandlers: readonly ApiRouteHandler[] = [
  handlePushRoutes,
  handleSessionRoutes,
  handleMiscRoutes,
]

/** 按声明顺序分发，首个命中的子路由短路。 */
export async function dispatchApi(
  req: Request,
  url: URL,
  handlers: readonly ApiRouteHandler[] = defaultHandlers,
): Promise<Response | undefined> {
  for (const handler of handlers) {
    const response = await handler(req, url)
    if (response !== undefined) return response
  }
  return undefined
}

export async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
  return dispatchApi(req, url)
}
