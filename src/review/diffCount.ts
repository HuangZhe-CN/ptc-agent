/** 行级 diff 计数：行多重集近似（与 git 数字接近且 O(n)）——快照 Review 汇总同用此函数。 */
export function countLineDiff(original: string, updated: string): { add: number; del: number } {
  const a = original.length && original !== '' ? original.replace(/\n$/, '').split('\n') : []
  const b = updated.replace(/\n$/, '').split('\n').filter(() => updated !== '')
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  let common = 0
  for (const line of b) {
    const n = counts.get(line) ?? 0
    if (n > 0) { common++; counts.set(line, n - 1) }
  }
  return { add: b.length - common, del: a.length - common }
}
