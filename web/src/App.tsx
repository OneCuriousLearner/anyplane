import { useState } from 'react'
import { SessionList } from './pages/SessionList'
import { Chat } from './pages/Chat'
import { ClaudeMark } from './components/ClaudeMark'
import type { SessionInfo } from './lib/api'

export default function App() {
  const [selected, setSelected] = useState<SessionInfo | undefined>()

  return (
    <div className="h-dvh bg-bg md:grid md:grid-cols-[300px_1fr] md:grid-rows-[minmax(0,1fr)]">
      {/* 移动端：选中后隐藏列表；桌面端：双栏常显 */}
      <div className={`h-full border-line md:border-r ${selected ? 'hidden md:block' : 'block'}`}>
        <SessionList selectedKey={selected?.key} onSelect={setSelected} />
      </div>
      <div className={`h-full ${selected ? 'block' : 'hidden md:block'}`}>
        {selected ? (
          <Chat session={selected} onBack={() => setSelected(undefined)} />
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
