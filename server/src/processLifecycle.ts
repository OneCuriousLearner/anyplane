export interface LifecycleLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface ProcessLifecycleDeps {
  stopServer(): void | Promise<void>
  disposeBackends(): void
  logPortState(stage: string): void
  exit(code: number): void
  log: LifecycleLogger
  timeoutMs?: number
  now?: () => number
}

export interface ProcessEventSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  on(event: 'uncaughtException', listener: (error: Error, origin: string) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown, promise: Promise<unknown>) => void): unknown
}

export interface ProcessLifecycle {
  shutdown(reason: string, exitCode?: number): Promise<void>
  fatal(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void
  isShuttingDown(): boolean
}

/**
 * 服务进程唯一关闭协调器。信号与致命异常共用同一条 stop/dispose 路径；
 * 重入只升级最终退出码，不重复清理。
 */
export function createProcessLifecycle(deps: ProcessLifecycleDeps): ProcessLifecycle {
  const timeoutMs = deps.timeoutMs ?? 5_000
  const now = deps.now ?? (() => performance.now())
  let shutdownPromise: Promise<void> | undefined
  let requestedExitCode = 0

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode)
    if (shutdownPromise) {
      deps.log.warn(`[anyplane] shutdown already in progress; repeated=${reason}`)
      return shutdownPromise
    }

    shutdownPromise = (async () => {
      const started = now()
      deps.log.info(`[anyplane] shutdown begin reason=${reason} pid=${process.pid}`)

      let stopPromise: Promise<void>
      try {
        deps.log.info('[anyplane] server.stop(true) begin')
        stopPromise = Promise.resolve(deps.stopServer())
      } catch (e) {
        deps.log.error('[anyplane] server.stop(true) invoke failed:', e)
        stopPromise = Promise.resolve()
      }

      try {
        deps.disposeBackends()
      } catch (e) {
        deps.log.error('[anyplane] disposeAll 失败:', e)
      }

      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), timeoutMs)
      })
      const stopped = stopPromise.then(
        () => 'stopped' as const,
        (e) => {
          deps.log.error('[anyplane] server.stop(true) rejected:', e)
          return 'failed' as const
        },
      )
      const result = await Promise.race([stopped, timedOut])
      if (timeout) clearTimeout(timeout)
      deps.log.info(`[anyplane] shutdown server=${result} elapsedMs=${Math.round(now() - started)}`)

      if (result === 'timeout') {
        requestedExitCode = 1
        deps.log.error(`[anyplane] shutdown timed out after ${timeoutMs}ms; forcing exit`)
      } else {
        deps.logPortState('after-stop')
        deps.log.info(`[anyplane] shutdown complete elapsedMs=${Math.round(now() - started)}`)
      }
      deps.exit(requestedExitCode)
    })()

    return shutdownPromise
  }

  const fatal = (kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void => {
    deps.log.error(`[anyplane] fatal ${kind}:`, error)
    void shutdown(kind, 1).catch((shutdownError) => {
      deps.log.error('[anyplane] fatal shutdown failed:', shutdownError)
      deps.exit(1)
    })
  }

  return { shutdown, fatal, isShuttingDown: () => shutdownPromise !== undefined }
}

export function installProcessHandlers(source: ProcessEventSource, lifecycle: ProcessLifecycle): void {
  source.on('SIGINT', () => void lifecycle.shutdown('SIGINT'))
  source.on('SIGTERM', () => void lifecycle.shutdown('SIGTERM'))
  source.on('uncaughtException', (error) => lifecycle.fatal('uncaughtException', error))
  source.on('unhandledRejection', (reason) => lifecycle.fatal('unhandledRejection', reason))
}
