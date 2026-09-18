// 提交前一键验证：与 CI 同口径依次跑 typecheck → lint → bun test。
// 纯 Bun 实现、零 shell 语法——Windows / Linux / macOS 同一行为
//（本项目本就全平台统一 Bun >= 1.4.0 门槛）。
//
// 存在理由：审查轮反复出现「本地只验证了一半就推送」的返工——
// tsc 重载不匹配到 CI 才红、lint 修复留到合并收尾、
// bun test 输出被管道截断掩盖失败计数（行为变了断言没跟上却看见"绿"）。
// 本脚本把三道验证收进一个必看的汇总出口：test 步结束后强制解析
// pass/fail 汇总行，解析不到视为失败，杜绝"半截输出当通过"。
import { hasSupportedBunVersion } from '../server/src/util'

export {}

const bun = process.execPath
// import.meta.dir 是 scripts/ 自身，仓库根是其上一级；spawn 一律锚定根目录
const root = import.meta.dir.replace(/[/\\][^/\\]+$/, '')

if (!hasSupportedBunVersion() && process.env.ANYPLANE_ALLOW_UNSAFE_BUN !== '1') {
  console.error(`[verify] 需要 Bun >= 1.4.0（当前 ${Bun.version}）。`)
  console.error('[verify] Run `bun upgrade`, restart the terminal, then run `bun run verify` again.')
  process.exit(1)
}

type Step = { name: string; args: string[] }
const steps: Step[] = [
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'lint', args: ['run', 'lint'] },
  { name: 'test', args: ['test'] },
]

// 先消费完流再 await exitCode，避免大输出撑满管道缓冲死锁子进程。
async function runStep(step: Step): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([bun, ...step.args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, out: out + err }
}

let failed = 0
for (const step of steps) {
  console.log(`\n=== [verify] ${step.name}: bun ${step.args.join(' ')} ===`)
  const { code, out } = await runStep(step)
  process.stdout.write(out)
  if (step.name !== 'test') {
    if (code !== 0) {
      failed++
      console.error(`\n[verify] ${step.name} 失败（exit ${code}），后续步骤跳过。`)
      break
    }
    continue
  }
  // test 步：退出码之外，强制确认完整 pass/fail 汇总行真实存在且 fail 为 0——
  // 教训：bun test 输出被截断时 exit code 之外的"绿"不可信（见 AGENTS.md 测试纪律）。
  const tail = out.slice(-800)
  const pass = tail.match(/(\d+)\s*pass(?:es)?\b/i)
  const fail = tail.match(/(\d+)\s*fail(?:ures)?\b/i)
  const failCount = fail ? Number(fail[1]) : null
  if (code !== 0 || failCount === null || failCount !== 0) {
    failed++
    if (failCount === null) {
      console.error('\n[verify] 未在输出尾部找到 pass/fail 汇总行——输出是否被截断？按失败处理。')
    }
    console.error(`[verify] test 失败（exit ${code}，汇总：${pass?.[0] ?? '?'} / ${fail?.[0] ?? '未找到'}）。`)
    console.error('[verify] 注意看上方完整失败计数与被截断的用例名，别只看最后一行。')
  } else {
    console.log(`\n[verify] test 汇总确认：${pass?.[0]} / ${fail?.[0]}`)
  }
}

if (failed > 0) {
  console.error('\n[verify] 未通过：修完再推。')
  process.exit(1)
}
console.log('\n[verify] 三道全绿，可以推送。')
