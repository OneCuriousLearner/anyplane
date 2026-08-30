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
    <div className="my-3 rounded-[14px] bg-accent/10 p-3.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs tracking-widest text-accent uppercase">审批</span>
        <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[11px] text-accent">
          {approval.toolName}
        </span>
        <span className="ml-auto font-mono text-[10px] text-faint">等待你的裁决</span>
      </div>
      <pre className="mt-2.5 max-h-48 overflow-auto rounded-[10px] bg-bg/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
        {inputStr.length > 2000 ? inputStr.slice(0, 2000) + '\n…（截断）' : inputStr}
      </pre>
      <div className="mt-3 flex gap-2">
        <button
          className="flex-1 rounded-full bg-ink py-2 text-sm font-medium text-bg"
          onClick={() => {
            const input = approval.input as Record<string, unknown> | undefined
            onDecision({ behavior: 'allow', updatedInput: input })
          }}
        >
          ✓ 允许
        </button>
        <button
          className="flex-1 rounded-full py-2 text-sm text-accent hover:bg-accent/10"
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
      className={`w-full rounded-[14px] px-2.5 py-2 text-left transition-colors ${
        props.pressed
          ? 'bg-surface2 text-ink'
          : 'bg-surface text-muted hover:bg-surface2 hover:text-ink'
      }`}
      onClick={props.onClick}
    >
      <span className="flex gap-2">
        <span className="font-mono text-xs text-muted">{props.pressed ? '●' : '○'}</span>
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
    <div className="my-3 rounded-[14px] bg-accent/10 p-3.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs tracking-widest text-accent uppercase">需要你的选择</span>
        <span className="ml-auto font-mono text-[10px] text-faint">AskUserQuestion</span>
      </div>
      <div className="mt-3 space-y-5">
        {input.questions.map((question) => {
          const selected = selections[question.question] ?? []
          const otherSelected = selected.includes('__other__')
          const selectedOption = question.options.find((option) => selected.includes(option.label))
          return (
            <section key={question.question}>
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] text-accent">
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
                    className="min-h-20 w-full resize-y rounded-[14px] bg-surface px-2.5 py-2 text-sm outline-none placeholder:text-faint focus:bg-surface2"
                  />
                )}
              </div>
              {selectedOption?.preview && !question.multiSelect && (
                <pre className="mt-2 max-h-48 overflow-auto rounded-[10px] bg-surface p-2 font-mono text-[11px] text-muted whitespace-pre-wrap">
                  {selectedOption.preview}
                </pre>
              )}
            </section>
          )
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="flex-1 rounded-full bg-ink py-2 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canSubmit}
          onClick={() => onDecision({ behavior: 'allow', updatedInput: withAskUserQuestionAnswers(input, selections, otherAnswers) })}
        >
          提交回答
        </button>
        <button
          className="rounded-full px-4 py-2 text-sm text-accent hover:bg-accent/10"
          onClick={() => onDecision({ behavior: 'deny', message: '用户未回答这些问题' })}
        >
          取消
        </button>
      </div>
    </div>
  )
}
