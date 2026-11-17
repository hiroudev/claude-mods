import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { linkedPaths, sizeText } from './register'

test('最終回答のリンクからローカルパスだけを拾う', async () => {
  const answer = '[報告書](out/report.xlsx) と [図](C:/work/a%20b.png:12) を作りました。[公式](https://example.com) [PR](#x)'
  expect(linkedPaths(answer)).toEqual(['out/report.xlsx', 'C:/work/a b.png'])
})

test('サイズ表記', async () => {
  expect([sizeText(512), sizeText(12_600), sizeText(3_400_000)]).toEqual(['512 B', '12.3 KB', '3.2 MB'])
})

const seed = (on: Parameters<TestBody>[1], isPlaced: boolean) => {
  on('session.cwd', () => ({ value: 'C:\\w' }))
  on('env.get', () => ({ value: 'C:\\Users\\me' }))
  on('clock.now', () => ({ value: 1000 }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 2048, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('ui.place', () => ({ value: isPlaced ? { isPlaced: true, requestId: 'r1' } : { isPlaced: false, reason: 'no-surface' } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

test('置いた行が各画面で描ける', async ($, on) => {
  seed(on, true)
  const r = await $.turn.complete({ answer: '[a](out/売上.xlsx) [b](out/手順.md)', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(r.text).toBe('[a](out/売上.xlsx) [b](out/手順.md)')
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'artifact-files', surface, component: 'Placed', requestId: 'r1', props: { id: 'f1000', plugin: 'artifact-files' } })
    expect((await ui.find({ type: 'Text', text: /売上\.xlsx/ }))?.text).toBe('売上.xlsx')
    await ui.unmount()
  }
})

test('行を置ける画面がなければ回答の下に注記で出す', async ($, on) => {
  seed(on, false)
  const r = await $.turn.complete({ answer: '[a](out/売上.xlsx)', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(r.text).toBe('**成果物 · 1件**\n\n- `XLSX` [売上.xlsx](<C:/w/out/売上.xlsx>) — 2.0 KB · [C:\\w\\out](<C:/w/out>)')
})
