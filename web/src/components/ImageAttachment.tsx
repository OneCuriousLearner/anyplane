import { memo } from 'react'

/** 图片附件：抄本行 / 侧问卡片 / user 气泡 / assistant 块展示共用 */
export const ImageAttachment = memo(function ImageAttachment(props: { src?: string }) {
  return (
    <img
      src={props.src}
      alt="图片附件"
      loading="lazy"
      className="my-1.5 max-h-64 max-w-full rounded-[10px] object-contain"
    />
  )
})
