import { expect, test } from 'claude-code/testing'

import { cacheRate, catLabel, collapse, ctxLevel, EMPTY, footerLine, forecast, fromCodexLog, kTokens, nextPerTurn, rateLevel, stackSvg, until, untilAuto } from './usage'

const H = 3600_000

test('しきい値：コンテキストは 60% で注意・80% で警告、利用枠は 70/90% か1時間以内に上限', async () => {
  expect(ctxLevel(null)).toBe('ok')
  expect(ctxLevel(59)).toBe('ok')
  expect(ctxLevel(60)).toBe('warn')
  expect(ctxLevel(80)).toBe('danger')
  const now = 1_000_000_000
  expect(rateLevel({ kind: 'five_hour', pct: 40, resetsAt: null, hitAt: null }, now)).toBe('ok')
  expect(rateLevel({ kind: 'five_hour', pct: 40, resetsAt: null, hitAt: now + 0.5 * H }, now)).toBe('warn')
  expect(rateLevel({ kind: 'five_hour', pct: 70, resetsAt: null, hitAt: null }, now)).toBe('warn')
  expect(rateLevel({ kind: 'seven_day', pct: 95, resetsAt: null, hitAt: null }, now)).toBe('danger')
})

test('上限到達の予測：直近の伸びを優先し、無ければ枠の平均。リセット前に届かなければ null', async () => {
  const now = 10 * 24 * H
  // 枠（5時間）の開始から2時間で 50% → 25%/時 → 残り 50% は2時間後、リセット（3時間後）より前
  expect(forecast({ pct: 50, now, resetsAt: now + 3 * H, windowMs: 5 * H, samples: [] })).toBe(now + 2 * H)
  // 2時間で 40% → 20%/時 → 3時間後 = リセットと同時なので届かない
  expect(forecast({ pct: 40, now, resetsAt: now + 3 * H, windowMs: 5 * H, samples: [] })).toBe(null)
  // 直近30分で 20% → 30%（20%/時）→ 残り 70% は 3.5時間後
  expect(forecast({ pct: 30, now, resetsAt: now + 4 * H, windowMs: 5 * H, samples: [{ t: now - 0.5 * H, pct: 20 }] })).toBe(now + 3.5 * H)
  // 5分未満の幅しかない直近値は使わず、枠の平均に戻る
  expect(forecast({ pct: 50, now, resetsAt: now + 3 * H, windowMs: 5 * H, samples: [{ t: now - 60_000, pct: 10 }] })).toBe(now + 2 * H)
  // 伸びていない・手がかりが無い
  expect(forecast({ pct: 30, now, resetsAt: null, samples: [{ t: now - H / 2, pct: 30 }] })).toBe(null)
  expect(forecast({ pct: 100, now, resetsAt: now + H, windowMs: 5 * H, samples: [] })).toBe(now)
})

test('長い出力は行の切れ目で先頭と末尾だけに', async () => {
  expect(collapse('短い出力')).toBe(null)
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`)
  const text = lines.join('\n')
  const out = collapse(text) as string
  expect(out.length < 6000).toBe(true)
  expect(out.startsWith('line 0 ')).toBe(true)
  expect(out.endsWith(lines[999] as string)).toBe(true)
  expect(/中略 \d+行・\d+文字/.test(out)).toBe(true)
  // 切り口は行の途中にならない
  expect(out.split('\n').filter(l => l.startsWith('line ')).every(l => /^line \d+ x{20}$/.test(l))).toBe(true)
  // 改行の無い1行は文字で切る
  const one = collapse('y'.repeat(20_000)) as string
  expect(one.startsWith('y'.repeat(3000) + '\n…')).toBe(true)
  expect(one.endsWith('\n' + 'y'.repeat(2000))).toBe(true)
})

test('数の整形とキャッシュ率', async () => {
  expect(kTokens(950)).toBe('950')
  expect(kTokens(3210)).toBe('3.2k')
  expect(kTokens(84_000)).toBe('84k')
  expect(kTokens(1_000_000)).toBe('1M')
  expect(until(80 * 60_000)).toBe('1:20後')
  expect(until(45 * 60_000)).toBe('45分後')
  expect(cacheRate({ input_tokens: 2, cache_read_input_tokens: 96, cache_creation_input_tokens: 2 })).toBe(96)
  expect(cacheRate({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(null)
})

const BAND = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'work-band', surface, component: 'AbovePrompt', requestId: `ap-${surface}`,
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as const

test('帯の利用状況：計測前は控えめ、しきい値を超えたら圧縮・引き継ぎのボタン', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 170_000, tokensAfter: 20_000 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface))
    // ふだんは帯に利用状況の行を出さない（数値は下部バー）
    expect(await ui.find({ type: 'Button', key: 'u-detail' })).toBe(undefined)
    expect(await ui.find({ type: 'Button', key: 'u-compact' })).toBe(undefined)
    await ui.unmount()
  }
  await $.session.measure({
    context: { tokens: 170_000, window: 200_000, percent: 85 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(Date.now() + H).toISOString() }, { kind: 'seven_day', percentUsed: 12 }],
    changed: ['context', 'rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface))
    expect((await ui.find({ type: 'Text', text: /コンテキスト 85%/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'u-detail' }))?.text).toBe('内訳')
    expect((await ui.find({ type: 'Text', text: /^5h 92%/ })) !== undefined).toBe(true)
    // 1w は他でも見られるので出さない
    expect(await ui.find({ type: 'Text', text: /1w/ })).toBe(undefined)
    expect((await ui.find({ type: 'Button', key: 'u-compact' }))?.text).toBe('要約して圧縮')
    expect((await ui.find({ type: 'Button', key: 'u-handoff' }))?.text).toBe('新規セッションで続ける')
    await ui.press({ key: 'u-compact' })
    // 圧縮後は計測し直し、使用率が下がればボタンは消える
    expect(await ui.find({ type: 'Button', key: 'u-compact' })).toBe(undefined)
    await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [{ kind: 'five_hour', percentUsed: 92 }, { kind: 'seven_day', percentUsed: 12 }], changed: ['context'] })
    await ui.unmount()
  }
})

test('節約（オプトイン）：オンにすると長い Bash 出力を中略し、外したセクションを送らない', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('ui.close', () => ({ value: undefined }))
  const long = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join('\n')
  on('tool.call', () => ({ result: { stdout: long, stderr: '', interrupted: false }, text: long }))
  on('prompt.section', (_, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x'.repeat(400), scope: 'shared' }, { id: 'memory', text: 'm'.repeat(4000), scope: 'session' }] }))

  // 既定はオフ：そのまま渡る
  const before = await $.tool.call({ tool: 'Bash', command: 'seq 2000' })
  expect((before.result as { stdout: string }).stdout).toBe(long)

  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const pane = { plugin: 'work-band', surface: 'desktop', component: 'Pane', requestId: 'settings', props: { title: '帯のカスタマイズ', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
  const ui = await $.ui.mount(pane)
  expect((await ui.find({ type: 'Button', key: 'sv-collapse' }))?.text).toBe('オフ')
  // 本体の指示（intro）は候補に出ない
  expect(await ui.find({ type: 'Button', key: 'sv-drop-intro' })).toBe(undefined)
  await ui.press({ key: 'sv-collapse' })
  await ui.press({ key: 'sv-drop-memory' })
  expect((await ui.find({ type: 'Button', key: 'sv-collapse' }))?.text).toBe('オン')
  expect((await ui.find({ type: 'Button', key: 'sv-drop-memory' }))?.text).toBe('外す')
  await ui.unmount()

  const after = await $.tool.call({ tool: 'Bash', command: 'seq 2000' })
  const stdout = (after.result as { stdout: string }).stdout
  expect(stdout.length < 6000).toBe(true)
  expect(stdout.includes('中略')).toBe(true)
  expect((await $.prompt.section({ name: 'memory', text: 'm' })).text).toBe(null)
  expect((await $.prompt.section({ name: 'env_info_simple', text: 'e' })).text).toBe('e')
})

test('内訳ペインが描ける', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 90_000, window: 200_000, percent: 45,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 8000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: 80_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 110_000, color: 'x', isDeferred: false, kind: 'free' },
          ],
          totalTokens: 90_000, maxTokens: 200_000, rawMaxTokens: 200_000, autocompactSource: 'auto', percentage: 45, gridRows: [], model: 'm',
          memoryFiles: [{ path: 'C:\\x\\CLAUDE.md', type: 'User', tokens: 900 }],
          mcpTools: [{ name: 'mcp__a__b', serverName: 'a', tokens: 300, isLoaded: true }],
          agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 167_000, apiUsage: null,
        },
      },
      rateLimits: [],
    },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  for (const surface of ['terminal', 'desktop'] as const) {
    // 入口は帯の「内訳」。帯の利用状況の行はしきい値を超えたときだけ出る
    await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], changed: ['context'] })
    const band = await $.ui.mount(BAND(surface))
    await band.press({ key: 'u-detail' })
    await band.unmount()
    await $.session.measure({ context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({ plugin: 'work-band', surface, component: 'Pane', requestId: 'context', props: { title: 'コンテキストの内訳', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    expect((await ui.find({ type: 'Text', text: /^会話$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /自動圧縮まで あと 77k/ })) !== undefined).toBe(true)
    // 帯と同じ圧縮・引き継ぎのボタンは内訳には出さない
    expect(await ui.find({ type: 'Button', key: 'cx-compact' })).toBe(undefined)
    expect((await ui.find({ type: 'Button', key: 'cx-refresh' }))?.text).toBe('更新')
    await ui.unmount()
  }
})

test('内訳の積み上げ帯：区分は左から幅を取り、自動圧縮の位置に印。区分名は日本語に', async () => {
  const svg = stackSvg([{ tokens: 50_000 }, { tokens: 50_000 }], 200_000, 150_000, 200)
  expect(svg.includes('width="50.0"')).toBe(true)
  expect(svg.includes('x="50.0"')).toBe(true)
  expect(svg.includes('x1="150.0"')).toBe(true)
  expect(stackSvg([], 200_000, null).includes('<line')).toBe(false)
  expect(catLabel('Messages')).toBe('会話')
  expect(catLabel('Unknown thing')).toBe('Unknown thing')
  expect(untilAuto(167_000, 90_000)).toBe(77_000)
  expect(untilAuto(null, 90_000)).toBe(null)
  expect(untilAuto(100, 200)).toBe(0)
})

test('下部バー：名前を付けずに 🤖 GPT・🦀 Claude の 5h / 1w と 📚 コンテキストを常に1行で', async ($, on) => {
  // エンジンが描くモード表示の代わりに、渡された modes を受け取る
  let modes: readonly string[] = []
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    modes = (e.props as { modes: readonly string[] }).modes
    const { Text } = $.ui.resolve(e)
    return <Text>{modes.join(' & ')}</Text>
  })
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 10_000_000 - 2 * 3600_000 - 45 * 60_000 }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 40_000, window: 200_000, percent: 20 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: new Date(10_000_000).toISOString() }, { kind: 'seven_day', percentUsed: 72 }],
    changed: ['context', 'rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'work-band', surface, component: 'SessionMode', requestId: `sm-${surface}`, props: { modes: ['focus'] } } as never)
    // 元のモード表示は前に残し、1行を足す。名前（work-band）は付けない。Codex のログが無いテスト環境でも 🤖 は「--」で出す
    expect(modes).toEqual(['focus', '🤖 5h --% -:-- / 1w --%  🦀 5h 34% 2:45 / 1w 72%  📚 20%'])
    await ui.unmount()
  }
  // Codex のログ：最後の rate_limits を 5h / 1w に振り分ける
  const log = [
    '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":1,"window_minutes":300,"resets_at":100}}}}',
    '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":9.4,"window_minutes":300,"resets_at":20000},"secondary":{"used_percent":1,"window_minutes":10080,"resets_at":900000}}}}',
    '{"type":"response_item"}',
  ].join('\n')
  const gpt = fromCodexLog(log) ?? {}
  expect(gpt.h5).toEqual({ pct: 9.4, resetsAt: 20_000_000 })
  const now = 10_000_000 - 2 * 3600_000 - 45 * 60_000
  const u = { ...EMPTY, tokens: 100_000, pct: 50, perTurn: 7000, limits: [{ kind: 'five_hour', pct: 34, resetsAt: 10_000_000, hitAt: null }] }
  expect(footerLine(u, 167_000, gpt, now)).toBe('🤖 5h 9% 5:32 / 1w 1%  🦀 5h 34% 2:45 / 1w --%  📚 50% · 圧縮まで 67k（約9回）')
  // リセット時刻を過ぎたら 0%・残り 5:00、値が無ければ「--」
  expect(footerLine({ ...u, pct: null, tokens: null }, null, {}, 10_000_001)).toBe('🤖 5h --% -:-- / 1w --%  🦀 5h 0% 5:00 / 1w --%  📚 --%')
  // 1往復の増え方：減った（圧縮）ときは据え置き、直近を重く見る
  expect(nextPerTurn(null, 5000)).toBe(5000)
  expect(nextPerTurn(5000, -3000)).toBe(5000)
  expect(nextPerTurn(5000, 10000)).toBe(7000)
})
