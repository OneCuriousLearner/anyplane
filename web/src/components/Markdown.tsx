import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 链接点击是否拦截（preventDefault）：AI 输出的 markdown 常把文件名渲染成 <a href="">，
 *  空 href 点击 = 重新加载当前页；# 锚点会改 location.hash，与 App 的 #s=<key> hash 路由
 *  打架（hashchange 解析不到会话 key 会被弹回列表）。两类都拦。
 *  此处是未来「点击文件名 → 文件预览」的天然挂点（拦截后可改走预览面板）。 */
export function shouldInterceptLink(href: string | null): boolean {
  return href === null || href === '' || href.startsWith('#')
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
