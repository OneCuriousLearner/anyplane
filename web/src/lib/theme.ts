/**
 * 深浅色主题：跟随系统（缺省）/ 手动深色 / 手动浅色。
 * 手动选择 = localStorage 持久化 + <html data-theme> 覆盖系统偏好；
 * CSS 侧契约见 index.css 顶部（:root[data-theme='light'] / 媒体查询内 :root:not([data-theme='dark'])）。
 * index.html 有防闪烁内联脚本在渲染前恢复 data-theme。
 * system 模式下不挂 JS 监听——去掉 data-theme 后 CSS 媒体查询自动跟随系统变化。
 */

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'anyplane-theme'

/** 用户选择：缺省/异常值一律视为跟随系统 */
export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* 隐私模式读不出 = 跟随系统 */
  }
  return 'system'
}

/** 应用选择：system 移除覆盖（CSS 媒体查询接管）；light/dark 写 data-theme 并持久化 */
export function setThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') {
    delete root.dataset.theme
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* 同上 */
    }
    return
  }
  root.dataset.theme = choice
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    /* 写不进去本次会话内仍然生效 */
  }
}

/** 当前生效主题（手动选择优先，缺省跟随系统） */
export function currentTheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme
  if (t === 'light' || t === 'dark') return t
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** 短按品牌标：深浅互切（显式选择，脱离跟随系统；长按菜单可切回） */
export function toggleTheme(): void {
  setThemeChoice(currentTheme() === 'dark' ? 'light' : 'dark')
}
