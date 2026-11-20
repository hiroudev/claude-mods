import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { dirParts, fileUrl, fitPath, linkedPaths, shortDir, sizeText, statusSvg } from './register'

test('file: URL は日本語・空白・括弧・# を符号化する', () => {
  expect(fileUrl('C:\\a b\\(x)#1\\確認.md')).toBe('file:///C:/a%20b/%28x%29%231/%E7%A2%BA%E8%AA%8D.md')
})

test('最終回答のリンクからローカルパスだけを拾う', async () => {
  const answer = '[報告書](out/report.xlsx) と [図](C:/work/a%20b.png:12) を作りました。[公式](https://example.com) [PR](#x)'
  expect(linkedPaths(answer)).toEqual(['out/report.xlsx', 'C:/work/a b.png'])
})

test('サイズ表記', async () => {
  expect([sizeText(512), sizeText(12_600), sizeText(3_400_000)]).toEqual(['512 B', '12.3 KB', '3.2 MB'])
})

test('フォルダ表記：絶対パスのまま、最後のフォルダ名を tail に残す', async () => {
  expect(dirParts('C:\\w\\docs\\design')).toEqual({ head: 'C:\\w\\docs\\', tail: 'design' })
  expect(dirParts('C:/Users/me/Documents/提案/')).toEqual({ head: 'C:\\Users\\me\\Documents\\', tail: '提案' })
  expect(dirParts('D:')).toEqual({ head: '', tail: 'D:\\' })
})

test('パス行は中間を省き、末尾のフォルダ名を残す', async () => {
  const p = 'C:\\Users\\me\\AppData\\Local\\SomeApp\\workspaces\\71fe126c\\card-test'
  expect(fitPath('C:\\w', 340)).toBe('C:\\w')
  const s = fitPath(p, 200)
  expect(s.startsWith('C:\\Users')).toBe(true)
  expect(s.endsWith('card-test')).toBe(true)
  expect(s.includes('…')).toBe(true)
})

test('状態アイコンは新規・更新で別の絵とツールチップ', async () => {
  expect(statusSvg('new')).toContain('<title>新規作成</title>')
  expect(statusSvg('upd')).toContain('<title>更新</title>')
})

// 疑似ファイルシステム
type Disk = Map<string, { size: number; mtimeMs: number }>
const k = (p: string) => p.replace(/\//g, '\\').toLowerCase()

// hasSurface=false は claude -p のように描ける画面が一つも無い状態
const seed = (on: Parameters<TestBody>[1], disk: Disk, hasSurface = true) => {
  on('session.cwd', () => ({ value: 'C:\\w' }))
  on('session.surfaces', () => ({ value: hasSurface ? ['desktop'] : [] }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : 'C:\\Users\\me\\AppData\\Local' }))
  on('fs.stat', (_, e) => {
    const f = disk.get(k(e.path))
    if (f === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false, realPath: e.path } }
  })
  on('fs.exists', (_, e) => ({ value: disk.has(k(e.path)) }))
  on('fs.list', (_, e) => {
    const dir = k(e.path ?? 'C:\\w')
    const entries = [...disk.entries()]
      .filter(([p]) => p.startsWith(`${dir}\\`) && !p.slice(dir.length + 1).includes('\\'))
      .map(([p, f]) => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: f.size, mtimeMs: f.mtimeMs, isLink: false }))
    return { value: entries }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // ツールの実体：Write は新規作成、Edit は更新、Bash は out.csv を作る
  on('tool.call', (_, e) => {
    if (e.tool === 'Write' || e.tool === 'Edit') disk.set(k(String(e.file_path)), { size: 2048, mtimeMs: 2000 })
    if (e.tool === 'Bash') disk.set(k('C:\\w\\out.csv'), { size: 10, mtimeMs: 3000 })
    return { result: {}, text: 'ok' } as never
  })
}

const complete = ($: Parameters<TestBody>[0], answer = '完了しました') =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

// その回答のブロックを描く（カードは回答の下に付く）
const mountAnswer = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' | 'mobile', text = '完了しました') =>
  $.ui.mount({ plugin: 'file-cards', surface, component: 'AssistantMessage', requestId: 'm1', props: { text, isFirstOfReply: true } })

test('新規・更新・シェル生成を拾い、各画面で描ける', async ($, on) => {
  const disk: Disk = new Map([[k('C:\\w\\src\\app.ts'), { size: 100, mtimeMs: 1000 }]])
  seed(on, disk)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\w\\提案書.pptx', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\w\\src\\app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'python make.py' })
  const r = await complete($)
  expect(r.text).toBe('完了しました')

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await mountAnswer($, surface)
    expect((await ui.find({ type: 'Text', text: /成果物/ }))?.text).toBe('成果物 · 新規 2 · 更新 1')
    expect((await ui.find({ type: 'Text', text: /提案書\.pptx/ }))?.text).toBe('提案書.pptx')
    expect((await ui.find({ type: 'Text', text: /^out\.csv$/ }))?.text).toBe('out.csv')
    expect((await ui.find({ type: 'Text', text: /^app\.ts$/ }))?.text).toBe('app.ts')
    await ui.unmount()
  }
})

test('4件以上は畳み、押すと全部出る', async ($, on) => {
  const disk: Disk = new Map()
  seed(on, disk)
  for (const n of ['a', 'b', 'c', 'd', 'e']) await $.tool.call({ tool: 'Write', file_path: `C:\\w\\${n}.md`, content: 'x' })
  await complete($)
  const ui = await mountAnswer($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^d\.md$/ })).toBe(undefined)
  await ui.press({ key: 'more' })
  expect((await ui.find({ type: 'Text', text: /^e\.md$/ }))?.text).toBe('e.md')
  await ui.unmount()
})

test('変更なしのターンはカードを出さない', async ($, on) => {
  seed(on, new Map())
  const r = await complete($)
  expect(r.text).toBe('完了しました')
  const ui = await mountAnswer($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /成果物/ })).toBe(undefined)
  await ui.unmount()
})

test('別の回答のブロックにはカードを付けない', async ($, on) => {
  seed(on, new Map())
  await $.tool.call({ tool: 'Write', file_path: 'C:\\w\\a.md', content: 'x' })
  await complete($, '作りました')
  const other = await mountAnswer($, 'desktop', '途中の説明です')
  expect(await other.find({ type: 'Text', text: /成果物/ })).toBe(undefined)
  await other.unmount()
  const own = await mountAnswer($, 'desktop', '作りました')
  expect((await own.find({ type: 'Text', text: /成果物/ }))?.text).toBe('成果物 · 新規 1')
  await own.unmount()
})

test('描ける画面が一つも無ければ回答の下に表で出す', async ($, on) => {
  const disk: Disk = new Map([[k('C:\\Users\\me\\Documents\\2026\\提案書\\業務改善\\a|b.md'), { size: 10, mtimeMs: 1 }]])
  seed(on, disk, false)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\w\\out\\売上.xlsx', content: 'x' })
  const r = await complete($, '[メモ](C:/Users/me/Documents/2026/提案書/業務改善/a|b.md)')
  expect(r.text).toBe(
    [
      '**成果物 · 新規 1**',
      '',
      '| 種類 | ファイル | 状態 | 容量 | フォルダ |',
      '|:-:|:--|:-:|--:|:--|',
      '| `MD` | [a\\|b.md](<C:/Users/me/Documents/2026/提案書/業務改善/a|b.md>) | — | 10 B | [C:\\\\Users\\\\me\\\\Documents\\\\2026\\\\提案書\\\\業務改善](<C:/Users/me/Documents/2026/提案書/業務改善>) |',
      '| `XLSX` | [売上.xlsx](<C:/w/out/売上.xlsx>) | 新規 | 2.0 KB | [C:\\\\w\\\\out](<C:/w/out>) |',
    ].join('\n'),
  )
})

test('長いフォルダは先頭と最後のフォルダ名だけ残す', async () => {
  expect(shortDir('~\\Documents\\2026\\提案書\\', '業務改善')).toBe('~\\Documents\\2026\\提案書\\業務改善')
  expect(shortDir('D:\\projects\\clients\\2026\\proposal\\assets\\', 'images')).toBe('D:\\…\\images')
})
