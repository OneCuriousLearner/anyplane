import { useState } from 'react'
import type { ApprovalDecision } from '../lib/decision'
import {
  isAskUserQuestionAnswered,
  parseAskUserQuestionInput,
  type AskUserQuestionInput,
  type AskUserQuestionOtherAnswers,
  type AskUserQuestionSelections,
  withAskUserQuestionAnswers,
} from '../lib/askUserQuestion'

export function ApprovalCard(props: {
  approval: { requestId: string; toolName: string; input: unknown }
  onDecision: (d: ApprovalDecision) => void
}) {
  const { approval, onDecision } = props
  const askUserQuestion = approval.toolName === 'AskUserQuestion' ? parseAskUserQuestionInput(approval.input) : null
  if (askUserQuestion) return <AskUserQuestionCard input={askUserQuestion} onDecision={onDecision} />

  const inputStr = JSON.stringify(approval.input, null, 2) ?? ''

  return (
    <div className="my-3 rounded-lg border border-busy/50 bg-busy/5">
      <div className="flex items-center gap-2 border-b border-busy/30 px-3 py-2">
        <span className="font-mono text-xs tracking-widest text-busy uppercase">审批</span>
        <span className="rounded border border-busy/40 bg-busy/10 px-1.5 py-0.5 font-mono text-[11px] text-busy">
          {approval.toolName}
        </span>
        <span className="ml-auto font-mono text-[10px] text-faint">等待你的裁决</span>
      </div>
      <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
        {inputStr.length > 2000 ? inputStr.slice(0, 2000) + '\n…（截断）' : inputStr}
      </pre>
      <div className="flex gap-2 border-t border-busy/30 p-2">
        <button
          className="flex-1 rounded bg-ok/90 py-2 text-sm font-medium text-bg hover:bg-ok"
          onClick={() => {
            const input = approval.input as Record<string, unknown> | undefined
            onDecision({ behavior: 'allow', updatedInput: input })
          }}
        >
          ✓ 允许
        </button>
        <button
          className="flex-1 rounded border border-danger/60 py-2 text-sm text-danger hover:bg-danger/10"
          onClick={() => onDecision({ behavior: 'deny', message: '用户在远程端拒绝了该操作' })}
        >
          ✗ 拒绝
        </button>
      </div>
    </div>
  )
}

/** 选项按钮：预设选项与「其他」共用的单/多选条目 */
function OptionButton(props: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      className={`w-full rounded border px-2.5 py-2 text-left transition-colors ${
        props.pressed
          ? 'border-accent bg-accent/15 text-ink'
          : 'border-line bg-surface/50 text-muted hover:border-accent/50 hover:bg-surface2'
      }`}
      onClick={props.onClick}
    >
      <span className="flex gap-2">
        <span className="font-mono text-xs text-accent-soft">{props.pressed ? '●' : '○'}</span>
        {props.children}
      </span>
    </button>
  )
}

function AskUserQuestionCard(props: { input: AskUserQuestionInput; onDecision: (d: ApprovalDecision) => void }) {
  const { input, onDecision } = props
  const [selections, setSelections] = useState<AskUserQuestionSelections>(() =>
    Object.fromEntries(input.questions.map((question) => [question.question, []])),
  )
  const [otherAnswers, setOtherAnswers] = useState<AskUserQuestionOtherAnswers>({})
  const canSubmit = input.questions.every((question) => isAskUserQuestionAnswered(question, selections, otherAnswers))

  const toggleOption = (questionText: string, label: string, multiSelect: boolean) => {
    setSelections((current) => {
      const selected = current[questionText] ?? []
      const next = multiSelect
        ? selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label]
        : [label]
      return { ...current, [questionText]: next }
    })
  }

  return (
    <div className="my-3 rounded-lg border border-accent/50 bg-accent/5">
      <div className="flex items-center gap-2 border-b border-accent/30 px-3 py-2">
        <span className="font-mono text-xs tracking-widest text-accent-soft uppercase">需要你的选择</span>
        <span className="ml-auto font-mono text-[10px] text-faint">AskUserQuestion</span>
      </div>
      <div className="space-y-5 p-3">
        {input.questions.map((question) => {
          const selected = selections[question.question] ?? []
          const otherSelected = selected.includes('__other__')
          const selectedOption = question.options.find((option) => selected.includes(option.label))
          return (
            <section key={question.question}>
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent-soft">
                  {question.header}
                </span>
                {question.multiSelect && <span className="font-mono text-[10px] text-faint">可多选</span>}
              </div>
              <p className="text-sm font-medium text-ink">{question.question}</p>
              <div className="mt-2 space-y-1.5">
                {question.options.map((option) => (
                  <OptionButton
                    key={option.label}
                    pressed={selected.includes(option.label)}
                    onClick={() => toggleOption(question.question, option.label, question.multiSelect)}
                  >
                    <span>
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs leading-relaxed text-faint">{option.description}</span>
                    </span>
                  </OptionButton>
                ))}
                <OptionButton
                  pressed={otherSelected}
                  onClick={() => toggleOption(question.question, '__other__', question.multiSelect)}
                >
                  <span className="text-sm font-medium">其他</span>
                </OptionButton>
                {otherSelected && (
                  <textarea
                    autoFocus
                    value={otherAnswers[question.question] ?? ''}
                    onChange={(event) => setOtherAnswers((current) => ({ ...current, [question.question]: event.target.value }))}
                    placeholder="请输入你的回答"
                    className="min-h-20 w-full resize-y rounded border border-accent/50 bg-surface px-2.5 py-2 text-sm outline-none placeholder:text-faint focus:border-accent"
                  />
                )}
              </div>
              {selectedOption?.preview && !question.multiSelect && (
                <pre className="mt-2 max-h-48 overflow-auto rounded border border-line bg-surface2/60 p-2 font-mono text-[11px] text-muted whitespace-pre-wrap">
                  {selectedOption.preview}
                </pre>
              )}
            </section>
          )
        })}
      </div>
      <div className="flex gap-2 border-t border-accent/30 p-2">
        <button
          className="flex-1 rounded bg-accent py-2 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canSubmit}
          onClick={() => onDecision({ behavior: 'allow', updatedInput: withAskUserQuestionAnswers(input, selections, otherAnswers) })}
        >
          提交回答
        </button>
        <button
          className="rounded border border-danger/60 px-4 py-2 text-sm text-danger hover:bg-danger/10"
          onClick={() => onDecision({ behavior: 'deny', message: '用户未回答这些问题' })}
        >
          取消
        </button>
      </div>
    </div>
  )
}
