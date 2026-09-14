import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 集成级红线：未配置 token 时脚本必须在任何子进程/网络动作之前拒绝执行（fail-closed）。
// HOME 指向空临时目录 → 三处配置候选全灭；token 检查在 spawn 隧道二进制之前，本测试不触碰隧道。

const script = join(import.meta.dir, 'public-access.ts')

function runWithoutToken(recipe: string): { exitCode: number; stderr: string } {
  const r = Bun.spawnSync(['bun', script, recipe], {
    stdout: 'pipe',
    stderr: 'pipe',
    // 裸环境：无 ANYPLANE_TOKEN、HOME 无 ~/.anyplane/config.json（PATH 仅用于找到 bun）
    env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'pa-test-')) },
  })
  return { exitCode: r.exitCode, stderr: r.stderr.toString() }
}

describe('public-access 无 token 拒绝执行', () => {
  test.each(['funnel', 'cf-quick'])('%s：exit 1 且指明 authToken', (recipe) => {
    const r = runWithoutToken(recipe)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('authToken')
    expect(r.stderr).toContain('拒绝执行')
  })
})
