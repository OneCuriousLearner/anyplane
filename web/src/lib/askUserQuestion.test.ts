import { describe, expect, test } from 'bun:test'
import {
  isAskUserQuestionAnswered,
  parseAskUserQuestionInput,
  withAskUserQuestionAnswers,
} from './askUserQuestion'

const input = parseAskUserQuestionInput({
  questions: [
    {
      question: '你接下来想让我写哪一种类型的故事？',
      header: '故事方向',
      options: [
        { label: '神话传说', description: '神灵与英雄' },
        { label: '科幻冒险', description: '宇宙与未来' },
      ],
      multiSelect: false,
    },
    {
      question: '故事中应有哪些元素？',
      header: '元素',
      options: [
        { label: '飞船', description: '太空旅行' },
        { label: '谜案', description: '调查线索' },
      ],
      multiSelect: true,
    },
  ],
})

describe('AskUserQuestion adapter', () => {
  test('returns option labels using Claude Code answers format', () => {
    expect(input).not.toBeNull()
    const answered = withAskUserQuestionAnswers(
      input!,
      {
        '你接下来想让我写哪一种类型的故事？': ['科幻冒险'],
        '故事中应有哪些元素？': ['飞船', '__other__'],
      },
      { '故事中应有哪些元素？': '时间循环' },
    )
    expect(answered.answers).toEqual({
      '你接下来想让我写哪一种类型的故事？': '科幻冒险',
      '故事中应有哪些元素？': '飞船, 时间循环',
    })
  })

  test('requires text when the Other option is selected', () => {
    const question = input!.questions[1]!
    expect(isAskUserQuestionAnswered(question, { [question.question]: ['__other__'] }, {})).toBe(false)
    expect(isAskUserQuestionAnswered(question, { [question.question]: ['__other__'] }, { [question.question]: '时间循环' })).toBe(true)
  })
})
