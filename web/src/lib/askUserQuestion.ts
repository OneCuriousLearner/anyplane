export interface AskUserQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[]
  answers?: Record<string, string>
  annotations?: Record<string, unknown>
  [key: string]: unknown
}

export type AskUserQuestionSelections = Record<string, string[]>
export type AskUserQuestionOtherAnswers = Record<string, string>

/** 宽松识别 CLI 的 AskUserQuestion 输入；不匹配时交回通用审批卡。 */
export function parseAskUserQuestionInput(input: unknown): AskUserQuestionInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) return null

  const questions: AskUserQuestion[] = []
  for (const value of raw.questions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const question = value as Record<string, unknown>
    if (typeof question.question !== 'string' || typeof question.header !== 'string' || !Array.isArray(question.options)) {
      return null
    }
    const options: AskUserQuestionOption[] = []
    for (const optionValue of question.options) {
      if (!optionValue || typeof optionValue !== 'object' || Array.isArray(optionValue)) return null
      const option = optionValue as Record<string, unknown>
      if (typeof option.label !== 'string' || typeof option.description !== 'string') return null
      options.push({
        label: option.label,
        description: option.description,
        preview: typeof option.preview === 'string' ? option.preview : undefined,
      })
    }
    if (options.length === 0) return null
    questions.push({
      question: question.question,
      header: question.header,
      options,
      multiSelect: question.multiSelect === true,
    })
  }
  return { ...raw, questions }
}

/** 生成 Claude Code 所要求的 answers（多选以逗号分隔，其他回答为原始文本）。 */
export function withAskUserQuestionAnswers(
  input: AskUserQuestionInput,
  selections: AskUserQuestionSelections,
  otherAnswers: AskUserQuestionOtherAnswers,
): AskUserQuestionInput {
  const answers: Record<string, string> = {}
  for (const question of input.questions) {
    const selected = new Set(selections[question.question] ?? [])
    const labels = question.options.filter((option) => selected.has(option.label)).map((option) => option.label)
    if (selected.has('__other__')) {
      const other = otherAnswers[question.question]?.trim()
      if (other) labels.push(other)
    }
    answers[question.question] = labels.join(', ')
  }
  return { ...input, answers }
}

export function isAskUserQuestionAnswered(
  question: AskUserQuestion,
  selections: AskUserQuestionSelections,
  otherAnswers: AskUserQuestionOtherAnswers,
): boolean {
  const selected = selections[question.question] ?? []
  if (selected.length === 0) return false
  return !selected.includes('__other__') || Boolean(otherAnswers[question.question]?.trim())
}
