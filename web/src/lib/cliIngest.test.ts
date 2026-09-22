import { describe, expect, test } from 'bun:test'
import { CLI_INGEST_TYPES, cliIngestTypeOf } from './cliIngest'

describe('cliIngestTypeOf 分发表', () => {
  test('表内 type 原样返回；未知 type（含只作为 subtype 的词）一律 undefined', () => {
    for (const type of CLI_INGEST_TYPES) {
      expect(cliIngestTypeOf(type)).toBe(type)
    }
    expect(cliIngestTypeOf('status')).toBeUndefined()
    expect(cliIngestTypeOf('init')).toBeUndefined()
    expect(cliIngestTypeOf('task_started')).toBeUndefined()
    expect(cliIngestTypeOf('compact_boundary')).toBeUndefined()
    expect(cliIngestTypeOf('')).toBeUndefined()
  })
})
