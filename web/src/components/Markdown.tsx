import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** AI/用户文本的 Markdown 渲染（GFM：表格、删除线、任务列表） */
export function Markdown(props: { text: string }) {
  return (
    <div className="prose-cc">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.text}</ReactMarkdown>
    </div>
  )
}
