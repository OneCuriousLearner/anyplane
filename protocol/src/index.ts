// @anyplane/protocol：server 与 web 的单一类型正本（WS 事件 / REST 形状 / 会话状态 / 历史消息）。
//
// 红线：本包**纯类型、零运行时、零依赖**——
//  - 消费方一律 `import type`（编译期擦除，npm 发布面与打包产物都不含本包）；
//  - 不 import server/web 的任何模块（尤其不反向依赖 vendor 协议：claude stream-json 的
//    丰富解析类型留在 server 侧 backends/claude/streamJson.ts，本包只声明中立边界形状）。

export type * from './types'
export type * from './history'
export type * from './state'
export type * from './events'
export type * from './inbox'
export type * from './rest'
