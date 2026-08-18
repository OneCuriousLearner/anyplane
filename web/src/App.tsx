import { useEffect, useState } from 'react'
import { SessionList } from './pages/SessionList'
import { Chat } from './pages/Chat'
import { ClaudeMark } from './components/ClaudeMark'
import { getToken, onAuthRequired, setToken } from './lib/auth'
import type { SessionInfo } from './lib/api'

export default function App() {
  const [selected, setSelected] = useState<SessionInfo | undefined>()
  const [authNeeded, setAuthNeeded] = useState(false)

  useEffect(() => onAuthRequired(() => setAuthNeeded(true)), [])

  if (authNeeded) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6">
        <ClaudeMark className="h-10 w-10 opacity-40" />
        <div className="font-mono text-xs tracking-widest text-faint">需要访问令牌</div>
        <form
          className="flex w-full max-w-xs gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const input = new FormData(e.currentTarget).get('token')
            if (typeof input === 'string' && input.trim()) {
              setToken(input.trim())
              location.reload()
            }
          }}
        >
          <input
            name="token"
            type="password"
            defaultValue={getToken() ?? ''}
            placeholder="authToken"
            autoFocus
            className="min-w-0 flex-1 rounded border border-line bg-surface px-3 py-2 text-sm outline-none"
          />
          <button type="submit" className="rounded bg-accent px-4 py-2 text-sm text-white">
            进入
          </button>
        </form>
        <div className="max-w-xs text-center text-xs text-faint">
          令牌在服务端的 cc-remote.config.json（authToken）或 CC_REMOTE_TOKEN 环境变量中配置
        </div>
      </div>
    )
  }

  return (
    <div className="h-dvh bg-bg md:grid md:grid-cols-[300px_1fr] md:grid-rows-[minmax(0,1fr)]">
      {/* 移动端：选中后隐藏列表；桌面端：双栏常显 */}
      <div className={`h-full border-line md:border-r ${selected ? 'hidden md:block' : 'block'}`}>
        <SessionList selectedKey={selected?.key} onSelect={setSelected} />
      </div>
      <div className={`h-full ${selected ? 'block' : 'hidden md:block'}`}>
        {selected ? (
          <Chat session={selected} onBack={() => setSelected(undefined)} onNavigate={setSelected} />
        ) : (
          <div className="hidden h-full flex-col items-center justify-center gap-3 text-faint md:flex">
            <ClaudeMark className="h-10 w-10 opacity-25" />
            <span className="font-mono text-xs tracking-widest">选择左侧会话，或新建一个</span>
          </div>
        )}
      </div>
    </div>
  )
}
