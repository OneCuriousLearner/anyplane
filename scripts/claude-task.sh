#!/usr/bin/env bash
# claude-task.sh — 在隔离 worktree 中运行一个 headless Claude 任务并产出 PR
#
# 用法:
#   bash scripts/claude-task.sh <task-name> [base-branch] [review-effort]
#
#   task-name      对应 .claude/tasks/<task-name>.md（simplify / code-review /
#                  security-review / test-coverage / test-cleanup）
#   base-branch    基准分支，默认 master
#   review-effort  仅 code-review 任务使用：/code-review 自带的 effort
#                  （low|medium|high|xhigh|max），默认 high。
#                  与 claude --effort 是两套独立机制。
#
# 生命周期:
#   git fetch → 从 origin/<base> 新建 worktree → claude -p 执行任务 →
#   兜底 push + 创建 PR → 清理 worktree 与本地分支。
#
# 失败时保留 worktree 现场供排查，并打印手动清理命令。
# 无改动时不开 PR，直接清理退出。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_NAME="${1:?用法: bash scripts/claude-task.sh <task-name> [base-branch] [review-effort]}"
BASE_BRANCH="${2:-master}"
REVIEW_EFFORT="${3:-high}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BRANCH="claude-${TASK_NAME}-${STAMP}"
WORKTREE_DIR="${REPO_ROOT}/.claude/worktrees/${BRANCH}"
PROMPT_FILE="${REPO_ROOT}/.claude/tasks/${TASK_NAME}.md"
MODEL="k3-256k"
EFFORT="max"

log() { printf '[claude-task] %s\n' "$*"; }

[[ -f "$PROMPT_FILE" ]] || { log "任务 prompt 不存在: $PROMPT_FILE"; exit 1; }

if [[ "$TASK_NAME" == "code-review" ]]; then
  case "$REVIEW_EFFORT" in
    low|medium|high|xhigh|max) ;;
    *) log "无效 review-effort: ${REVIEW_EFFORT}（可选: low|medium|high|xhigh|max）"; exit 1 ;;
  esac
fi

cd "$REPO_ROOT"
log "git fetch origin ${BASE_BRANCH}"
git fetch origin "$BASE_BRANCH"

log "创建 worktree: ${WORKTREE_DIR} (分支 ${BRANCH})"
git worktree add "$WORKTREE_DIR" -b "$BRANCH" "origin/${BASE_BRANCH}"

cleanup() {
  cd "$REPO_ROOT"
  if git worktree remove --force "$WORKTREE_DIR" 2>/dev/null; then
    log "worktree 已清理"
  fi
  git branch -D "$BRANCH" 2>/dev/null || true
}

cd "$WORKTREE_DIR"

# 把本次运行的分支信息注入 prompt，让 Claude 能精确 push / 建 PR
RUN_INFO="- 当前分支名: ${BRANCH}
- PR 的 base 分支: ${BASE_BRANCH}"

PROMPT="$(cat "$PROMPT_FILE")"

# code-review：替换首行命令中的 {review-effort} 占位符（该 effort 是
# /code-review 自带参数，由 harness 直接解析，与 claude --effort 无关）
if [[ "$TASK_NAME" == "code-review" ]]; then
  PROMPT="$(printf '%s' "$PROMPT" | sed "s|{review-effort}|${REVIEW_EFFORT}|g")"
  RUN_INFO="${RUN_INFO}
- /code-review 自带 effort: ${REVIEW_EFFORT}（已在首行命令中生效；--fix 必带，否则 review 只报告不修复）"
fi

PROMPT="${PROMPT}

## 本次运行信息

${RUN_INFO}"

# 结果 JSON 归档到主 checkout（worktree 清理后仍可查；.claude/ 已 gitignore）
TASK_LOG_DIR="${REPO_ROOT}/.claude/task-logs"
mkdir -p "$TASK_LOG_DIR"
RESULT_JSON="${TASK_LOG_DIR}/${BRANCH}.json"

log "运行 claude -p (model=${MODEL}, effort=${EFFORT}, permission-mode=bypassPermissions)"
CLAUDE_EXIT=0
claude -p "$PROMPT" \
      --permission-mode bypassPermissions \
      --model "$MODEL" \
      --effort "$EFFORT" \
      --output-format json > "$RESULT_JSON" || CLAUDE_EXIT=$?

# 提取会话元数据，方便事后查证 transcript
SESSION_ID="$(jq -r '.session_id // "unknown"' "$RESULT_JSON" 2>/dev/null || echo "unknown")"
# 注意：jq 的 // 对 false 也会取替代值，is_error 不能用 // 提取
IS_ERROR="$(jq -r '.is_error | if . == null then "unknown" else tostring end' "$RESULT_JSON" 2>/dev/null || echo "unknown")"
COST_USD="$(jq -r '.total_cost_usd // empty' "$RESULT_JSON" 2>/dev/null || true)"
DURATION_MS="$(jq -r '.duration_ms // empty' "$RESULT_JSON" 2>/dev/null || true)"
SLUG="$(printf '%s' "$WORKTREE_DIR" | sed 's|[/.]|-|g')"
TRANSCRIPT="${HOME}/.claude/projects/${SLUG}/${SESSION_ID}.jsonl"

log "session_id: ${SESSION_ID}"
log "transcript: ${TRANSCRIPT}"
if [[ -n "$COST_USD" ]]; then log "cost: \$${COST_USD}"; fi
if [[ "$DURATION_MS" =~ ^[0-9]+$ ]]; then log "duration: $((DURATION_MS / 1000))s"; fi
log "结果 JSON: ${RESULT_JSON}"

# 任务总结文本打进日志（保持可读性）
jq -r '.result // empty' "$RESULT_JSON" 2>/dev/null || true

# 失败判定：退出码非 0，或退出码 0 但运行内部失败（is_error=true）
if [[ "$CLAUDE_EXIT" != "0" || "$IS_ERROR" == "true" ]]; then
  log "❌ claude 执行失败 (exit=${CLAUDE_EXIT}, is_error=${IS_ERROR})，保留现场: ${WORKTREE_DIR}"
  log "排查后可手动清理:"
  log "  git worktree remove --force '${WORKTREE_DIR}' && git branch -D '${BRANCH}'"
  exit 1
fi

CHANGE_COUNT="$(git rev-list --count "origin/${BASE_BRANCH}..HEAD")"
if [[ "$CHANGE_COUNT" == "0" ]]; then
  log "没有产生任何 commit，无需 PR，直接清理"
  cleanup
  log "✅ 任务结束（无改动）"
  exit 0
fi

log "产生 ${CHANGE_COUNT} 个 commit，push 兜底（若 claude 已 push 则为 no-op）"
git push -u origin "$BRANCH"

if PR_URL="$(gh pr view "$BRANCH" --json url --jq .url 2>/dev/null)"; then
  log "PR 已存在（claude 已创建）: ${PR_URL}"
else
  log "claude 未建 PR，脚本兜底创建 → base=${BASE_BRANCH}"
  PR_URL="$(gh pr create \
    --title "chore(${TASK_NAME}): automated run ${STAMP}" \
    --body "$(printf '自动化任务 `%s` 的运行结果。\n\n- 分支: `%s`\n- 由 `scripts/claude-task.sh` 生成' "$TASK_NAME" "$BRANCH")" \
    --base "$BASE_BRANCH" \
    --head "$BRANCH")"
  log "✅ PR 已创建: ${PR_URL}"
fi

cleanup
log "✅ 任务结束"
