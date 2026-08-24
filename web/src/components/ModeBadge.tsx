import { useEffect } from 'react'

function prodHref(): string {
  const { protocol, hostname, port } = location
  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    return `${protocol}//${hostname}:7480/`
  }
  const host = port && port !== '80' && port !== '443' ? `${hostname}:${port}` : hostname
  return `${protocol}//${host}/?mode=prod`
}

/** 仅 Vite 开发包显示。点击新开生产标签页，当前 DEV 页不关。生产构建不含此组件。 */
export function ModeBadge() {
  useEffect(() => {
    document.title = 'DEV · cc-remote'
    return () => {
      document.title = 'cc-remote'
    }
  }, [])

  return (
    <button
      type="button"
      onClick={() => window.open(prodHref(), '_blank', 'noopener,noreferrer')}
      aria-label="开发模式，点击新开生产标签页"
      title={'开发模式 · Vite :5173\n点击新开生产标签页'}
      className="fixed z-[9999] flex items-center gap-1.5 rounded-full border border-busy/40 bg-bg/75 px-2.5 py-1 font-mono text-[10px] tracking-widest text-busy shadow-[0_8px_24px_-8px_rgba(0,0,0,0.65)] backdrop-blur-md"
      style={{
        bottom: 'max(0.75rem, env(safe-area-inset-bottom))',
        left: 'max(0.75rem, env(safe-area-inset-left))',
      }}
    >
      <span className="mode-badge-pulse size-1.5 rounded-full bg-busy" aria-hidden />
      DEV
    </button>
  )
}
