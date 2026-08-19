import { describe, it, expect } from 'vitest'
import { countLineDiff } from '../src/review/diffCount'

describe('countLineDiff', () => {
  it('纯新增/纯删除/修改/不变', () => {
    expect(countLineDiff('a\nb', 'a\nb')).toEqual({ add: 0, del: 0 })
    expect(countLineDiff('a\nb', 'a\nb\nc')).toEqual({ add: 1, del: 0 })
    expect(countLineDiff('a\nb\nc', 'a')).toEqual({ add: 0, del: 2 })
    expect(countLineDiff('a\nb', 'a\nX')).toEqual({ add: 1, del: 1 })
  })
  it('尾部换行一致性', () => {
    expect(countLineDiff('a\n', 'a\nb\n')).toEqual({ add: 1, del: 0 })
  })
})
