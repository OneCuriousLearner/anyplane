import { describe, expect, test } from 'bun:test'
import { rewindPreview } from './blocks'

describe('rewindPreview', () => {
  test('removes internal reminders and summarizes slash commands', () => {
    expect(
      rewindPreview(
        '<system-reminder>internal context</system-reminder><command-name>compact</command-name><command-args>focus on API</command-args>',
      ),
    ).toEqual({ summary: '/compact focus on API', detail: '/compact focus on API' })
  })

  test('omits local command output while keeping the user intent', () => {
    expect(
      rewindPreview('请检查当前项目。<local-command-stdout>\u001b[32mvery long command output\u001b[0m</local-command-stdout>然后总结。'),
    ).toEqual({ summary: '请检查当前项目。\n\n然后总结。', detail: '请检查当前项目。\n\n然后总结。' })
  })

  test('truncates only the summary and retains readable detail', () => {
    const preview = rewindPreview('这是一个很长的请求，'.repeat(30), 20)
    expect(preview.summary).toBe('这是一个很长的请求，这是一个很长的请求，…')
    expect(preview.detail.length).toBeGreaterThan(preview.summary.length)
  })
})
