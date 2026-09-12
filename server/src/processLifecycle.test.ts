import { describe, expect, test } from 'bun:test'
import {
  createProcessLifecycle,
  installProcessHandlers,
  type LifecycleLogger,
  type ProcessEventSource,
} from './processLifecycle'

function captureLog(): LifecycleLogger & { rows: string[] } {
  const rows: string[] = []
  const write = (...args: unknown[]) => rows.push(args.map(String).join(' '))
  return { rows, info: write, warn: write, error: write }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createProcessLifecycle', () => {
  test('正常信号按 stop → dispose → 端口诊断顺序清理并以 0 退出', async () => {
    const events: string[] = []
    const lifecycle = createProcessLifecycle({
      stopServer: () => {
        events.push('stop')
      },
      disposeBackends: () => events.push('dispose'),
      logPortState: (stage) => events.push(`port:${stage}`),
      exit: (code) => events.push(`exit:${code}`),
      log: captureLog(),
    })

    await lifecycle.shutdown('SIGTERM')

    expect(events).toEqual(['stop', 'dispose', 'port:after-stop', 'exit:0'])
    expect(lifecycle.isShuttingDown()).toBe(true)
  })

  test('关闭中发生致命异常只清理一次，并把最终退出码升级为 1', async () => {
    const gate = deferred()
    const exits: number[] = []
    let stops = 0
    let disposals = 0
    const log = captureLog()
    const lifecycle = createProcessLifecycle({
      stopServer: () => {
        stops++
        return gate.promise
      },
      disposeBackends: () => {
        disposals++
      },
      logPortState: () => {},
      exit: (code) => exits.push(code),
      log,
    })

    const shutdown = lifecycle.shutdown('SIGINT')
    const fatalOrigin = () => new Error('boom')
    lifecycle.fatal('unhandledRejection', fatalOrigin())
    gate.resolve()
    await shutdown

    expect(stops).toBe(1)
    expect(disposals).toBe(1)
    expect(exits).toEqual([1])
    expect(log.rows.some((row) => row.includes('fatal unhandledRejection') && row.includes('boom'))).toBe(true)
    expect(log.rows.some((row) => row.includes('\n    at ') && row.includes('processLifecycle.test.ts'))).toBe(true)
    expect(log.rows.some((row) => row.includes('repeated=unhandledRejection'))).toBe(true)
  })

  test('stop 拒绝与 dispose 抛错均留痕，仍完成关闭', async () => {
    const exits: number[] = []
    const log = captureLog()
    const lifecycle = createProcessLifecycle({
      stopServer: () => Promise.reject(new Error('stop failed')),
      disposeBackends: () => {
        throw new Error('dispose failed')
      },
      logPortState: () => {},
      exit: (code) => exits.push(code),
      log,
    })

    await lifecycle.shutdown('SIGTERM')

    expect(exits).toEqual([0])
    expect(log.rows.some((row) => row.includes('server.stop(true) rejected') && row.includes('stop failed'))).toBe(true)
    expect(log.rows.some((row) => row.includes('disposeAll 失败') && row.includes('dispose failed'))).toBe(true)
  })

  test('stop 超时强制以 1 退出且不执行完成后的端口诊断', async () => {
    const exits: number[] = []
    let portDiagnostics = 0
    const lifecycle = createProcessLifecycle({
      stopServer: () => new Promise<void>(() => {}),
      disposeBackends: () => {},
      logPortState: () => {
        portDiagnostics++
      },
      exit: (code) => exits.push(code),
      log: captureLog(),
      timeoutMs: 5,
    })

    await lifecycle.shutdown('SIGTERM')

    expect(exits).toEqual([1])
    expect(portDiagnostics).toBe(0)
  })
})

describe('installProcessHandlers', () => {
  test('信号与两类致命事件注册到统一生命周期', () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const source: ProcessEventSource = {
      on(event: string, listener: (...args: never[]) => void) {
        listeners.set(event, listener)
      },
    } as ProcessEventSource
    const calls: string[] = []
    const lifecycle = {
      shutdown: async (reason: string) => {
        calls.push(`shutdown:${reason}`)
      },
      fatal: (kind: string, error: unknown) => {
        calls.push(`fatal:${kind}:${String(error)}`)
      },
      isShuttingDown: () => false,
    }

    installProcessHandlers(source, lifecycle)
    listeners.get('SIGINT')?.()
    listeners.get('SIGTERM')?.()
    listeners.get('uncaughtException')?.(new Error('sync') as never, 'origin' as never)
    listeners.get('unhandledRejection')?.('async' as never, Promise.resolve() as never)

    expect(calls).toEqual([
      'shutdown:SIGINT',
      'shutdown:SIGTERM',
      'fatal:uncaughtException:Error: sync',
      'fatal:unhandledRejection:async',
    ])
  })
})
