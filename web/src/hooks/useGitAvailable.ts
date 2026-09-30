// git 可用性探测（Chat「改动」页签与 DirPicker「拉 worktree 开会话」入口的隐藏判定，同源一份）。

import { useEffect, useState } from 'react'
import { fetchGitAvailable } from '../lib/api'

/** 进入页面探测一次：git 缺席时 worktree/「改动」功能整体降级（入口隐藏），失败按缺席处理 */
export function useGitAvailable(): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    fetchGitAvailable()
      .then(setAvailable)
      .catch(() => {})
  }, [])
  return available
}
