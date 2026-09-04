import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** AI/用户文本的 Markdown 渲染（GFM：表格、删除线、任务列表）。
 *  memo：text 不变时跳过 ReactMarkdown 重解析（渲染链里最重的单项）。 */
export const Markdown = memo(function Markdown(props: { text: string }) {
  return (
    <div className="prose-cc">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.text}</ReactMarkdown>
    </div>
  )
})
