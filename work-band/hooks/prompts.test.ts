import { expect, test } from 'claude-code/testing'

import { PROMPTS } from './prompts'

test('保存プロンプト：アイコンを押すと保存した文をそのまま送る（デスクトップとターミナル）', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  const sent: string[] = []
  let box = ''
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', (_$, e) => {
    box = e.text
    return { isFilled: true } as never
  })
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = { plugin: 'work-band', surface, component: 'AbovePrompt', requestId: `pp-${surface}`, props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
    const ui = await $.ui.mount(band)
    const key = surface === 'desktop' ? 'prb-recommend' : 'pr-recommend'
    expect((await ui.find({ type: 'Button', key })) !== undefined).toBe(true)
    await ui.press({ key })
    await ui.press({ key: surface === 'desktop' ? 'prb-japanese' : 'pr-japanese' })
    await ui.unmount()
  }
  const rec = PROMPTS.find(p => p.key === 'recommend')?.text
  const ja = PROMPTS.find(p => p.key === 'japanese')?.text
  expect(sent).toEqual([rec, ja, rec, ja])
  // 入力中の下書きがあれば、その後ろに付けて送り、入力欄は空にする
  box = 'この案で'
  const ui = await $.ui.mount({ plugin: 'work-band', surface: 'desktop', component: 'AbovePrompt', requestId: 'pp-draft', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await ui.press({ key: 'prb-recommend' })
  await ui.unmount()
  expect(sent[4]).toBe(`この案で

${rec}`)
  expect(box).toBe('')
})

test('お気に入り：未登録なら案内、設定で文と見出しを変えると帯から送れる', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string; message?: string }).text ?? (e as { message?: string }).message ?? ''))
    return { value: undefined } as never
  })
  const sent: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: true }) as never)
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  const band = { plugin: 'work-band', surface: 'desktop', component: 'AbovePrompt', requestId: 'fav', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
  let ui = await $.ui.mount(band)
  expect((await ui.find({ type: 'Button', key: 'prb-image' })) !== undefined).toBe(true)
  await ui.press({ key: 'prb-fav1' })
  // ペインを出せないテストでは帯の中で設定が開くので、完了で閉じる
  expect((await ui.find({ type: 'Button', key: 'done' })) !== undefined).toBe(true)
  await ui.press({ key: 'done' })
  await ui.unmount()
  expect(sent).toEqual([])
  expect(toasts.length).toBe(1)

  const pane = { plugin: 'work-band', surface: 'desktop', component: 'Pane', requestId: 'settings', props: { title: '帯のカスタマイズ', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} } } as const
  const set = await $.ui.mount(pane)
  await set.input({ key: 'pe-text-fav1', text: 'テストを書いてから直して' })
  await set.input({ key: 'pe-short-fav1', text: '試験' })
  await set.input({ key: 'pe-text-recommend', text: '一番よい案だけ' })
  await set.unmount()

  ui = await $.ui.mount(band)
  expect((await ui.find({ type: 'Button', key: 'prb-fav1' }))?.text).toBe('\u3000試験')
  await ui.press({ key: 'prb-fav1' })
  await ui.press({ key: 'prb-recommend' })
  await ui.unmount()
  expect(sent).toEqual(['テストを書いてから直して', '一番よい案だけ'])
})

test('並び順：設定の ↑↓ で帯のボタンの順番が変わる', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  const pane = { plugin: 'work-band', surface: 'desktop', component: 'Pane', requestId: 'settings', props: { title: '帯のカスタマイズ', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 300 }, view: {} } } as const
  const set = await $.ui.mount(pane)
  // 文を送らない「画像」は名前欄が無く、並び替えだけ
  expect(await set.find({ type: 'Input', key: 'pe-short-image' })).toBe(undefined)
  for (let i = 0; i < 6; i++) await set.press({ key: 'pe-up-image' })
  await set.press({ key: 'pe-dn-recommend' })
  await set.unmount()
  const band = { plugin: 'work-band', surface: 'terminal', component: 'AbovePrompt', requestId: 'order', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
  const ui = await $.ui.mount(band)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('pr-'))
  await ui.unmount()
  expect(keys.slice(0, 3)).toEqual(['pr-image', 'pr-japanese', 'pr-recommend'])
})
