import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 链接点击是否拦截（preventDefault）：
 *  - 空 href / 空白：AI 常把文件名渲染成 <a href="">，点击 = 刷新当前页
 *  - # 锚点：改 location.hash，与 App 的 #s=<key> 路由打架（弹回列表）
 *  - javascript:/data:/vbscript:：不让 markdown 当脚本入口
 *  - 相对路径 / Windows 路径 / 同站绝对路径：会卸掉 SPA
 *  显式 http(s)/mailto/file 外链放行。
 *  此处是未来「点击文件名 → 文件预览」的天然挂点。 */
export function shouldInterceptLink(href: string | null): boolean {
  if (href == null) return true
  const t = href.trim()
  if (!t) return true
  if (t.startsWith('#')) return true
  if (/^(javascript|data|vbscript):/i.test(t)) return true
  if (/^(https?:|mailto:|file:)/i.test(t)) return false
  return true
}

/** AI/用户文本的 Markdown 渲染（GFM：表格、删除线、任务列表）。
 *  memo：text 不变时跳过 ReactMarkdown 重解析（渲染链里最重的单项）。 */
export const Markdown = memo(function Markdown(props: { text: string }) {
  return (
    <div
      className="prose-cc"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (a && shouldInterceptLink(a.getAttribute('href'))) e.preventDefault()
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.text}</ReactMarkdown>
    </div>
  )
})
