// Transcript tailer：tail 未被 anyplane spawn 的外部会话（如终端里跑着的交互式 claude）
// 的 transcript JSONL，把新追加的完整消息实时推给浏览器。
// 粒度是「完整消息」而非 token 增量——token 级流式只有 spawn 路径（stream-json 协议）才有。

import { closeSync, existsSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { entryToHistoryMessage, isSelectableRewindTarget, type HistoryMessage } from './discovery'

export interface TailerEvents {
  onMessage: (msg: HistoryMessage) => void
  /** 文件被截断/重建（外部 rewind、/clear 等）：tailer 已自停，调用方应通知客户端重载历史后重新订阅 */
  onReset: () => void
  /** 每次检查（watch 触发或轮询）后回调，供 Hub 节流刷新外部会话的 busy/idle 状态 */
  onTick: () => void
}

const POLL_MS = 2000

export class TranscriptTailer {
  private offset: number
  private pending = Buffer.alloc(0)
  private watcher?: FSWatcher
  private pollTimer?: ReturnType<typeof setInterval>
  private debounce?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(
    private path: string,
    startOffset: number | undefined,
    private events: TailerEvents,
  ) {
    // 未指定偏移时只关注新内容（与「加载历史后订阅」的调用约定一致）
    this.offset = startOffset ?? this.size()
  }

  start(): void {
    this.ensureWatcher()
    // watch 在某些写法（替换式写入、网络盘）下会丢事件，低频轮询兜底
    this.pollTimer = setInterval(() => this.flush(), POLL_MS)
    this.flush()
  }

  stop(): void {
    this.stopped = true
    if (this.debounce) clearTimeout(this.debounce)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.watcher?.close()
    this.watcher = undefined
  }

  private size(): number {
    try {
      return statSync(this.path).size
    } catch {
      return 0 // 文件尚未创建（pid 会话刚起步）或已删除
    }
  }

  private ensureWatcher(): void {
    if (this.watcher || this.stopped || !existsSync(this.path)) return
    try {
      this.watcher = watch(this.path, { persistent: false }, () => {
        // 合并突发写入，一次 flush 读完
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => this.flush(), 50)
      })
      this.watcher.on('error', () => {
        this.watcher = undefined // 轮询兜底
      })
    } catch {
      this.watcher = undefined
    }
  }

  private flush(): void {
    if (this.stopped) return
    this.ensureWatcher()
    const size = this.size()
    if (size < this.offset) {
      // 截断/重建：偏移已失效。自停并通知，等客户端重载历史后用新偏移重新订阅，
      // 避免从 0 重放整个文件与重载结果重复。
      this.stop()
      this.events.onReset()
      return
    }
    if (size > this.offset) {
      let fd = -1
      try {
        fd = openSync(this.path, 'r')
        const buf = Buffer.alloc(size - this.offset)
        readSync(fd, buf, 0, buf.length, this.offset)
        this.offset = size
        this.emitLines(buf)
      } catch {
        // 读失败（文件被占用/轮换）：下轮 flush 重试
      } finally {
        if (fd >= 0)
          try {
            closeSync(fd)
          } catch {}
      }
    }
    this.events.onTick()
  }

  private emitLines(buf: Buffer): void {
    // 0x0A 不会出现在多字节 UTF-8 序列里，可按字节安全切分完整行
    const data = this.pending.length ? Buffer.concat([this.pending, buf]) : buf
    const lastNl = data.lastIndexOf(0x0a)
    if (lastNl < 0) {
      this.pending = Buffer.from(data)
      return
    }
    this.pending = Buffer.from(data.subarray(lastNl + 1))
    for (const line of data.subarray(0, lastNl).toString('utf8').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(t)
      } catch {
        continue // 写了一半的行：留给下轮（pending 已保留尾部，这里仅防御）
      }
      const msg = entryToHistoryMessage(obj)
      if (!msg) continue
      // tail 消息在正常订阅路径下都位于已加载历史之后（最后的 compact 边界之后），
      // 只需过官方同款的 rewind 目标过滤
      msg.rewindable = msg.role === 'user' ? isSelectableRewindTarget(obj) : true
      this.events.onMessage(msg)
    }
  }
}
