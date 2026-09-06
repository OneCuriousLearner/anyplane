// 被 protocol-drift.yml 的 github-script 调用：缺标签就建、按标题前缀去重、再开 issue。
// 仓库 GITHUB_TOKEN 默认只读，workflow 必须显式 issues:write；标签不存在时 create 会 422。

const LABEL = 'protocol-drift'

module.exports = async function openDriftIssue({ github, context, core }) {
  const owner = context.repo.owner
  const repo = context.repo.repo
  const prefix = process.env.DRIFT_TITLE_PREFIX
  const body = process.env.DRIFT_BODY
  if (!prefix || !body) throw new Error('DRIFT_TITLE_PREFIX / DRIFT_BODY 未设置')

  try {
    await github.rest.issues.getLabel({ owner, repo, name: LABEL })
  } catch (e) {
    if (e.status !== 404) throw e
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: LABEL,
      color: 'B45309',
      description: 'CLI / SDK 协议与仓库基线漂移',
    })
    core.info(`已创建标签 ${LABEL}`)
  }

  // 用 listForRepo 而不是 search：search 有索引延迟，且额外权限不稳
  const { data: issues } = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    labels: LABEL,
    per_page: 50,
  })
  if (issues.some((i) => !i.pull_request && i.title.includes(prefix))) {
    core.info('已有未关闭的漂移 issue，跳过重复创建')
    return
  }

  const title = `${prefix}（${new Date().toISOString().slice(0, 10)}）`
  const created = await github.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels: [LABEL],
  })
  core.info(`已开 issue #${created.data.number} ${title}`)
}
