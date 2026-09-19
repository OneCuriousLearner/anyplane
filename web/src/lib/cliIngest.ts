// handleCli 按 type 分发的闭集。CliMsg.type 是宽松 string，这张表是前端实际消费的入口。
// 增删 type 先改这里——useTranscriptIngest 的 switch 对 CliIngestType 穷尽，漏 case 编译不过。

export const CLI_INGEST_TYPES = [
  'stream_event',
  'control_response',
  'assistant',
  'user',
  'system',
  'result',
] as const

export type CliIngestType = (typeof CLI_INGEST_TYPES)[number]

const CLI_INGEST_SET: ReadonlySet<string> = new Set(CLI_INGEST_TYPES)

export function cliIngestTypeOf(type: string): CliIngestType | undefined {
  return CLI_INGEST_SET.has(type) ? (type as CliIngestType) : undefined
}
