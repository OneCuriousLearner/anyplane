import { describe, expect, test } from 'bun:test'
import { run, type RunDeps } from './public-access-lib'

// 全部进程内注入：绝不 spawn 真实隧道二进制——在本机跑 bun test 不应可能改写 tailnet 配置
// （评审发现：旧 spawn 集成测试只隔离了 HOME，仓库根 anyplane.config.json 会穿透 token 门槛）。

function makeDeps(overrides: Partial<RunDeps> = {}): RunDeps & {
  calls: { which: string[]; spawnSync: string[][]; foreground: string[][]; writeFile: string[]; serverUp: number[] }
  logs: { out: string[]; err: string[] }
} {
  const calls = { which: [] as string[], spawnSync: [] as string[][], foreground: [] as string[][], writeFile: [] as string[], serverUp: [] as number[] }
  const logs = { out: [] as string[], err: [] as string[] }
  return {
    calls,
    logs,
    loadConfig: () => ({}),
    env: {},
    platform: 'linux',
    which: (bin) => {
      calls.which.push(bin)
      return `/usr/bin/${bin}`
    },
    exists: () => true,
    serverUp: async (port) => {
      calls.serverUp.push(port)
      return true
    },
    stateDir: () => '/tmp/fake-home/.anyplane/caddy',
    writeFile: async (path, content) => {
      calls.writeFile.push(`${path}\n${content}`)
    },
    foreground: async (cmd) => {
      calls.foreground.push(cmd)
      return 0
    },
    spawnSync: (cmd) => {
      calls.spawnSync.push(cmd)
      return { exitCode: 0, stdout: '{}' }
    },
    out: (m) => logs.out.push(m),
    err: (m) => logs.err.push(m),
    ...overrides,
  }
}

describe('run() 安全红线：未配 token 一律拒绝', () => {
  test.each(['funnel', 'cf-quick'])('%s：exit 1、指明 authToken、且在任何副作用之前', async (recipe) => {
    const deps = makeDeps()
    const code = await run([recipe], deps)
    expect(code).toBe(1)
    expect(deps.logs.err.join('\n')).toContain('拒绝执行')
    expect(deps.logs.err.join('\n')).toContain('authToken')
    // token 判定不得被任何配置候选穿透：二进制探测/服务预检/spawn 全部未发生
    expect(deps.calls.which).toEqual([])
    expect(deps.calls.serverUp).toEqual([])
    expect(deps.calls.spawnSync).toEqual([])
    expect(deps.calls.foreground).toEqual([])
  })

  test('ANYPLANE_TOKEN 可放行 token 检查（进入后续预检）', async () => {
    const deps = makeDeps({ env: { ANYPLANE_TOKEN: 'x'.repeat(32) } })
    await run(['funnel'], deps)
    expect(deps.calls.serverUp).toEqual([7480])
  })
})

describe('run() 预检与分支', () => {
  test('无参数打印 USAGE 且 exit 1（不触碰配置）', async () => {
    let loadConfigCalls = 0
    const deps = makeDeps({
      loadConfig: () => {
        loadConfigCalls++
        return {}
      },
    })
    const code = await run([], deps)
    expect(code).toBe(1)
    expect(deps.logs.out.join('\n')).toContain('用法')
    expect(loadConfigCalls).toBe(0)
  })

  test('本地服务未起 → 明确报错，不 spawn', async () => {
    const deps = makeDeps({ env: { ANYPLANE_TOKEN: 't' }, serverUp: async () => false })
    const code = await run(['cf-quick'], deps)
    expect(code).toBe(1)
    expect(deps.logs.err.join('\n')).toContain('无响应')
    expect(deps.calls.foreground).toEqual([])
  })

  test('funnel：无 /dev/net/tun 拒绝并指向 cf-quick', async () => {
    const deps = makeDeps({ env: { ANYPLANE_TOKEN: 't' }, exists: () => false })
    const code = await run(['funnel'], deps)
    expect(code).toBe(1)
    expect(deps.logs.err.join('\n')).toContain('/dev/net/tun')
    expect(deps.calls.spawnSync).toEqual([])
  })

  test('funnel 全通：执行最小命令并打印 ts.net 地址', async () => {
    const deps = makeDeps({
      env: { ANYPLANE_TOKEN: 't' },
      spawnSync: (cmd) => {
        deps.calls.spawnSync.push(cmd)
        if (cmd[1] === 'status') return { exitCode: 0, stdout: JSON.stringify({ Self: { DNSName: 'host.tail123.ts.net.' } }) }
        return { exitCode: 0, stdout: '' }
      },
    })
    const code = await run(['funnel'], deps)
    expect(code).toBe(0)
    expect(deps.calls.spawnSync).toEqual([
      ['/usr/bin/tailscale', 'funnel', '--bg', '7480'],
      ['/usr/bin/tailscale', 'status', '--json'],
    ])
    expect(deps.logs.out.join('\n')).toContain('https://host.tail123.ts.net')
  })

  test('funnel 命令失败 → 透传退出信息', async () => {
    const deps = makeDeps({ env: { ANYPLANE_TOKEN: 't' }, spawnSync: () => ({ exitCode: 1, stdout: '' }) })
    const code = await run(['funnel'], deps)
    expect(code).toBe(1)
    expect(deps.logs.err.join('\n')).toContain('退出码 1')
  })

  test('cf-quick：前台托管 cloudflared 到本地端口', async () => {
    const deps = makeDeps({ env: { ANYPLANE_TOKEN: 't' } })
    const code = await run(['cf-quick', '--port', '7499'], deps)
    expect(code).toBe(0)
    expect(deps.calls.foreground).toEqual([['/usr/bin/cloudflared', 'tunnel', '--url', 'http://localhost:7499']])
  })

  test('caddy：渲染 Caddyfile 落库并前台 run', async () => {
    const deps = makeDeps({ env: { ANYPLANE_TOKEN: 't' } })
    const code = await run(['caddy', 'ap.example.com'], deps)
    expect(code).toBe(0)
    expect(deps.calls.writeFile).toHaveLength(1)
    expect(deps.calls.writeFile[0]).toContain('/tmp/fake-home/.anyplane/caddy/Caddyfile')
    expect(deps.calls.writeFile[0]).toContain('ap.example.com:8443 {')
    expect(deps.calls.writeFile[0]).toContain('reverse_proxy 127.0.0.1:7480')
    expect(deps.calls.foreground).toEqual([['/usr/bin/caddy', 'run', '--config', '/tmp/fake-home/.anyplane/caddy/Caddyfile']])
  })

  test('二进制缺失 → 安装指引', async () => {
    const deps = makeDeps({ env: { ANYPLANE_TOKEN: 't' }, which: () => null })
    const code = await run(['cf-quick'], deps)
    expect(code).toBe(1)
    expect(deps.logs.err.join('\n')).toContain('未找到 cloudflared')
    expect(deps.calls.foreground).toEqual([])
  })
})
