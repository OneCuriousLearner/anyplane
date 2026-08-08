import { useState } from 'react'
import { SessionList } from './pages/SessionList'
import { Chat } from './pages/Chat'
import type { SessionInfo } from './lib/api'

export default function App() {
  const [selected, setSelected] = useState<SessionInfo | undefined>()

  return (
    <div className="h-dvh bg-zinc-950 md:grid md:grid-cols-[340px_1fr]">
      {/* 移动端：选中后隐藏列表；桌面端：双栏常显 */}
      <div className={`h-full ${selected ? 'hidden md:block' : 'block'}`}>
        <SessionList selectedKey={selected?.key} onSelect={setSelected} />
      </div>
      <div className={`h-full ${selected ? 'block' : 'hidden md:block'}`}>
        {selected ? (
          <Chat session={selected} onBack={() => setSelected(undefined)} />
        ) : (
          <div className="hidden h-full items-center justify-center text-zinc-600 md:flex">
            选择一个会话开始
          </div>
        )}
      </div>
    </div>
  )
}
