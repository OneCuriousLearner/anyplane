// bun.lock URL 闸：packages 区任何条目的 tarball URL 字段必须为空（默认源规范形）。
//
// 为什么：bun 会把安装时所配 registry 的 URL 写进 lockfile——谁本机配了镜像，
// bun add 就把镜像地址烧进共享 lockfile，CI/其他机器随后去那台镜像拉包
//（npmmirror/tencent 各留过一批，PR #103 归零并立此闸）。根 bunfig.toml 已锁
// 官方源做预防，本闸做检测兜底（--registry 显式指定、未来 bun 行为漂移都拦得住）。
//
// 触发后的修法：把对应条目的 URL 字段置空（hash 与 registry 无关，不用换版本），
// 并检查本机 ~/.npmrc 是否又配了镜像。
//
// 纯 Bun 实现（verify/CI 双平台同一行为）；未来若确有 git/tarball 直连依赖，
// 在这里加白名单并写明原因。

const lockfile = await Bun.file(`${import.meta.dir}/../bun.lock`).text()

const offenders: string[] = []
for (const line of lockfile.split('\n')) {
  // 条目形态：    "pkg": ["pkg@1.0.0", "<URL>", {...}, "sha512-..."],
  // 只匹配行首条目位（4 空格缩进 + 引号键），workspaces 区的版本约束不会带 http
  if (/^ {4}"[^"]+": \[[^\]]*"https?:\/\//.test(line)) offenders.push(line.trim())
}

if (offenders.length > 0) {
  console.error(`[check-lockfile] bun.lock 检出 ${offenders.length} 条非空 tarball URL（应为默认源规范形空串）：`)
  for (const l of offenders.slice(0, 5)) console.error(`  ${l.slice(0, 120)}…`)
  if (offenders.length > 5) console.error(`  …共 ${offenders.length} 条`)
  console.error('[check-lockfile] 修法：URL 字段置空；并检查本机 registry 配置（见根 bunfig.toml 注释）。')
  process.exit(1)
}
console.log('[check-lockfile] bun.lock 全部条目为默认源规范形（URL 空）。')
