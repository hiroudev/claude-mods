import { expect, mock, test } from 'claude-code/testing'

import {
  cleanPrompt, countFindings, detectDelim, expandTemplate, firstSentence, fmt, isDangerous, move, normalize, parseCsv, parseFindings, parseGitStatus, parseReview,
  quoteForDisplay, reviewProgress, SEED_SCRIPTS, summarize, teePath, toMarkdownTable,
} from './register'

test('codex review の引数からモデル・対象・観点を読む', async () => {
  const r = parseReview(`& $codex review --base main -c 'model="gpt-x"' -c 'model_reasoning_effort="xhigh"' "セキュリティ重視" 2>&1 | Tee-Object -FilePath x`, { model: 'def', effort: 'high' })
  expect(r).toEqual({ model: 'gpt-x', effort: 'xhigh', target: 'base: main', prompt: 'セキュリティ重視' })
  expect(parseReview('codex.exe review --uncommitted', { model: 'def', effort: 'high' }).target).toBe('未コミット差分')
})

test('ヒアストリングの依頼文：記号と引用符を外し、空白をまとめ、帯には1文目', async () => {
  const d = { model: 'def', effort: 'high' }
  const single = `& $codex review --uncommitted -c 'model="gpt-x"' @'\r\nReview ONLY the uncommitted changes under src/ (ignore others). Focus:   app.js\r\n  decides "明日の 0:53" text.\r\n'@ 2>&1 |\r\n  Tee-Object -FilePath "C:\\t\\r.txt"`
  const r = parseReview(single, d)
  expect(r).toEqual({ model: 'gpt-x', effort: 'high', target: '未コミット差分', prompt: 'Review ONLY the uncommitted changes under src/ (ignore others). Focus: app.js decides "明日の 0:53" text.' })
  expect(firstSentence(r.prompt)).toBe('Review ONLY the uncommitted changes under src/ (ignore others).')
  const double = `& $codex review --base main @"\nセキュリティ観点で見て。特に 'eval' の使い方。\n"@ | Tee-Object x.txt`
  expect(parseReview(double, d)).toEqual({ model: 'def', effort: 'high', target: 'base: main', prompt: "セキュリティ観点で見て。特に 'eval' の使い方。" })
  expect(firstSentence("セキュリティ観点で見て。特に 'eval' の使い方。")).toBe('セキュリティ観点で見て。')
  // ヒアストリングとして取り出せなかった記号が語として残った場合も外す
  expect(cleanPrompt(`@' Review   the diff '@`)).toBe('Review the diff')
  expect(cleanPrompt('"quoted text"')).toBe('quoted text')
  expect(firstSentence('no period here')).toBe('no period here')
  expect(firstSentence('v1.2 fixes it. Then more')).toBe('v1.2 fixes it.')
})

test('並べ替えと欠けた要素の補完', async () => {
  const l = normalize({ order: ['jobs', 'icon'], hidden: ['nope' as never] })
  expect(l.order[0]).toBe('jobs')
  expect(l.order.length).toBe(12)
  expect(l.hidden).toEqual([])
  expect(move(l, 'icon', -1).order.slice(0, 2)).toEqual(['icon', 'jobs'])
  expect(move(l, 'jobs', -1)).toEqual(l)
})

test('時間と要約の整形', async () => {
  expect(fmt(65_000)).toBe('1:05')
  expect(fmt(3_725_000)).toBe('1:02:05')
  expect(summarize({ command: 'git  push\n origin' })).toBe('git push origin')
})

test('帯と設定画面がデスクトップとターミナルで描ける', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('ui.close', () => ({ value: undefined }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = { plugin: 'work-band', surface, component: 'AbovePrompt', requestId: `ap-${surface}`, props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
    const ui = await $.ui.mount(band)
    expect((await ui.find({ type: 'Input', key: 'draft' })) !== undefined).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'send' })).toBe(undefined)
    await ui.press({ key: 'gear' })
    expect((await ui.find({ type: 'Text', text: /帯のカスタマイズ/ }))?.text).toBe('帯のカスタマイズ')
    await ui.press({ key: 'vis-icon' })
    expect((await ui.find({ type: 'Button', key: 'vis-icon' }))?.text).toBe('非表示')
    await ui.press({ key: 'reset' })
    await ui.press({ key: 'done' })
    await ui.unmount()
  }
})

test('設定はペインで描ける', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  const pane = { plugin: 'work-band', surface: 'desktop', component: 'Pane', requestId: 'settings', props: { title: '帯のカスタマイズ', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
  const ui = await $.ui.mount(pane)
  expect((await ui.find({ type: 'Button', key: 'up-review' }))?.text).toBe('↑')
  await ui.press({ key: 'dn-approvals' })
  expect((await ui.find({ type: 'Button', key: 'done' }))?.text).toBe('完了')
  await ui.press({ key: 'done' })
  await ui.unmount()
})

// ---- スクリプト・Git・レビュー進捗 ----

test('テンプレート展開：入力は1つの引数のまま、シェルには環境変数で渡す', async () => {
  const x = expandTemplate('rg -n -e "{input}" {cwd}', 'a b"; rm -rf / & echo', 'C:\\My Work')
  expect(x).toEqual({ argv: ['rg', '-n', '-e', 'a b"; rm -rf / & echo', 'C:\\My Work'], env: {} })
  // -e の直後なら - 始まりも検索語として渡せる
  expect('argv' in expandTemplate('rg -e "{input}"', '--pre=calc', 'C:\\')).toBe(true)
  // それ以外の位置ではオプション扱いになるので拒否
  expect('error' in expandTemplate('rg "{input}" .', '--pre=calc', 'C:\\')).toBe(true)
  expect('argv' in expandTemplate('rg -- "{input}" .', '--pre=calc', 'C:\\')).toBe(true)
  expect(expandTemplate('git log --oneline -20', '', 'C:\\')).toEqual({ argv: ['git', 'log', '--oneline', '-20'], env: {} })
  expect('error' in expandTemplate('rg -e "{input}"', '  ', 'C:\\')).toBe(true)
  expect('error' in expandTemplate('{input} --version', 'x', 'C:\\')).toBe(true)
  expect(expandTemplate('powershell -NoProfile -Command "Get-ChildItem -Filter {input}"', "x'; Remove-Item C:\\ #", 'C:\\')).toEqual({
    argv: ['powershell', '-NoProfile', '-Command', 'Get-ChildItem -Filter $env:WB_INPUT'],
    env: { WB_INPUT: "x'; Remove-Item C:\\ #" },
  })
  expect(expandTemplate('bash -c "grep -r {input} ."', '$(id)', '/')).toEqual({ argv: ['bash', '-c', 'grep -r "$WB_INPUT" .'], env: { WB_INPUT: '$(id)' } })
  expect('error' in expandTemplate('cmd /c findstr {input} *.txt', 'a & del x', 'C:\\')).toBe(true)
  expect('argv' in expandTemplate('cmd /c findstr {input} *.txt', 'abc', 'C:\\')).toBe(true)
  expect(quoteForDisplay(['rg', '-e', 'a b', ''])).toBe('rg -e "a b" ""')
})

test('書き換え・削除を含むコマンドの検出', async () => {
  const bad = ['sqlite3 db "DELETE FROM t"', 'sqlite3 db "update t set a=1"', 'drop table x', 'INSERT INTO t VALUES (1)', 'alter table t add c', 'TRUNCATE t', 'rm -rf build', 'git rm a.txt', 'cmd /c del x.txt', 'powershell -Command "Remove-Item x"']
  for (const s of bad) expect([s, isDangerous(s)]).toEqual([s, true])
  const ok = ['sqlite3 db "SELECT * FROM t"', 'rg -n -e "{input}" .', 'git log --oneline -20', 'rg -e updated_at .', 'npm run form']
  for (const s of ok) expect([s, isDangerous(s)]).toEqual([s, false])
})

test('CSV / TSV の読み取りと表への変換', async () => {
  const csv = 'name,note\r\n"Smith, J","say ""hi"""\r\nA,"multi\nline"\r\n'
  expect(parseCsv(csv, ',')).toEqual([['name', 'note'], ['Smith, J', 'say "hi"'], ['A', 'multi\nline']])
  expect(detectDelim(csv)).toBe(',')
  expect(detectDelim('a\tb\n1\t2\n')).toBe('\t')
  expect(detectDelim('src/a.ts:1:foo, bar\nsrc/b.ts:2:baz\n')).toBe('')
  expect(detectDelim('one line,only')).toBe('')
  expect(toMarkdownTable([['a', 'b|c'], ['1']])).toBe('| a | b\\|c |\n| --- | --- |\n| 1 |   |')
})

test('Codex レビュー出力：進捗の1行と指摘の読み取り', async () => {
  const running = 'OpenAI Codex v0.1\n--------\nuser\nReview it\nexec\n"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "git diff --stat" in C:\\repo\n succeeded in 80ms:\n a.ts | 2 +-\n'
  expect(reviewProgress(running)).toBe('実行: git diff --stat')
  expect(reviewProgress(`${running}\ncodex\nThe change looks mostly fine; checking callers.\n`)).toBe('The change looks mostly fine; checking callers.')
  expect(reviewProgress('just\n\nsome text\n')).toBe('some text')
  const log = `${running}codex\nsummary\n\nFull review comments:\n\n- [P1] Null check missing — C:\\repo\\a.ts:10-12\n  When x is undefined\n  this throws.\n\n- [P2] Typo — C:\\repo\\b.ts:3-3\n  minor\n- [P1] Null check missing — C:\\repo\\a.ts:10-12\n  When x is undefined\n`
  const f = parseFindings(log)
  expect(f).toEqual([
    { severity: 'P1', title: 'Null check missing', location: 'C:\\repo\\a.ts:10-12', body: 'When x is undefined this throws.' },
    { severity: 'P2', title: 'Typo', location: 'C:\\repo\\b.ts:3-3', body: 'minor' },
  ])
  expect(countFindings(f)).toBe('P1 1 · P2 1')
  expect(countFindings([])).toBe('指摘なし')
  expect(parseFindings('no comments here')).toEqual([])
  expect(teePath('& $codex review --uncommitted 2>&1 |\n  Tee-Object -FilePath "C:\\tmp\\codex-review.txt"')).toBe('C:\\tmp\\codex-review.txt')
  expect(teePath("codex review | tee -a '/tmp/r.txt'")).toBe('/tmp/r.txt')
  expect(teePath('codex review --uncommitted')).toBe('')
})

test('git status --porcelain=v2 の読み取り', async () => {
  const out = '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.ts\n? new.txt\n'
  expect(parseGitStatus(out)).toEqual({ branch: 'main', changes: 2, ahead: 2, behind: 1, hasUpstream: true })
  expect(parseGitStatus('# branch.head (detached)\n')).toEqual({ branch: '（detached HEAD）', changes: 0, ahead: 0, behind: 0, hasUpstream: false })
})

const seed = (values: Record<string, unknown>) => ($: unknown, e: { key: string }, next: (e: never) => unknown) =>
  e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e as never)

const BAND = (surface: 'terminal' | 'desktop', requestId: string) =>
  ({ plugin: 'work-band', surface, component: 'AbovePrompt', requestId, props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } }) as const

const RUN = {
  scriptId: 's-csv', name: 'CSV を SQL で', icon: 'db', input: 'select * from t', command: 'sqlite3 -csv :memory: "select * from t"', dir: 'C:\\w',
  startedAt: 1000, endedAt: 1310, status: 'done', exitCode: 0, output: 'id,name\n1,a\n2,b\n', stderr: '', delim: ',', count: 2, isTruncated: false,
}

test('帯：Git 行・スクリプト行・レビュー進捗がデスクトップとターミナルで描ける', async ($, on) => {
  on('state.get', seed({
    git: { shape: 'git-1', value: { branch: 'feature/x', changes: 3, ahead: 1, behind: 0, hasUpstream: true } },
    scripts: { shape: 'scripts-1', value: SEED_SCRIPTS },
    scriptRun: { shape: 'run-1', value: RUN },
    reviews: { shape: 'reviews-1', value: [
      { id: 'r1', model: 'gpt-x', effort: 'high', target: '未コミット差分', prompt: '', startedAt: 0, endedAt: null, status: 'running', isBackground: false, progress: '実行: git diff' },
      { id: 'r2', model: 'gpt-x', effort: 'high', target: '未コミット差分', prompt: '', startedAt: 0, endedAt: 5000, status: 'done', isBackground: false, findings: [{ severity: 'P1', title: 't', location: '', body: '' }] },
    ] },
  }) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface, `ap2-${surface}`))
    expect((await ui.find({ type: 'Text', text: /feature\/x/ }))?.text).toBe('feature/x')
    expect((await ui.find({ type: 'Text', text: /^未コミット \d/ }))?.text).toBe('未コミット 3')
    expect((await ui.find({ type: 'Text', text: /↑1/ }))?.text).toBe('↑1 ↓0')
    expect((await ui.find({ type: 'Button', key: 'git-review' }))?.text).toBe('レビュー中…')
    expect((await ui.find({ type: 'Text', text: /実行: git diff/ }))?.text).toBe('実行: git diff')
    expect((await ui.find({ type: 'Text', text: /^P1 1$/ }))?.text).toBe('P1 1')
    expect((await ui.find({ type: 'Button', key: 'rv-detail-r2' }))?.text).toBe('詳細')
    expect((await ui.find({ type: 'Button', key: 'rv-detail-r1' }))?.text).toBe('詳細')
    // 「Codex レビュー」「実行中」の文字は出さない（状態は●の色と alt）
    expect(await ui.find({ type: 'Text', text: /Codex レビュー|実行中|完了/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^未コミット差分$/ }))?.text).toBe('未コミット差分')
    expect((await ui.find({ type: 'Text', text: /^gpt-x high$/ }))?.text).toBe('gpt-x high')
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).some(s => /実行中/.test(JSON.stringify(s)))).toBe(true)
    // 1行に収める：行は折り返さず、伸び縮みするのは依頼文／進捗の箱だけ
    type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
    const byKey = (n: Node, key: string): Node | undefined =>
      n.props?.key === key ? n : (n.children ?? []).map(c => (typeof c === 'object' && c !== null ? byKey(c as Node, key) : undefined)).find(Boolean)
    const rv = byKey((await ui.drawn()) as Node, 'rv-r1') as Node
    expect(rv.props?.flexWrap).toBe('nowrap')
    const shrinks = (rv.children as Node[]).map(c => c.props?.flexShrink)
    expect(shrinks).toEqual([0, 0, 0, 0, 1, 0])
    expect((await ui.find({ type: 'Text', text: /✓ 2件/ }))?.text).toBe('✓ 2件 · 0.31秒')
    expect(await ui.find({ type: 'Button', key: 'script-run' })).toBe(undefined)
    await ui.unmount()
  }
})

test('スクリプト実行：危険なコマンドは確認してから実行し、結果ペインに表で出る', async ($, on) => {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'id,name\n1,a\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.set', () => ({ value: undefined }))
  mock.clock(on)
  on('state.get', seed({ scripts: { shape: 'scripts-1', value: SEED_SCRIPTS }, scriptId: 's-csv' }) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    calls.length = 0
    const ui = await $.ui.mount(BAND(surface, `ap3-${surface}`))
    await ui.input({ key: 'script-arg', text: 'DELETE FROM t' })
    expect(calls.length).toBe(0)
    expect((await ui.find({ type: 'Button', key: 'script-confirm' }))?.text).toBe('確認して実行')
    await ui.press({ key: 'script-confirm' })
    expect(calls[0]?.slice(-1)).toEqual(['DELETE FROM t'])
    expect((await ui.find({ type: 'Text', text: /✓ 1件/ })) !== undefined).toBe(true)
    await ui.input({ key: 'script-arg', text: 'select 1' })
    expect(calls.length).toBe(2)
    await ui.unmount()
    const pane = await $.ui.mount({ plugin: 'work-band', surface, component: 'Pane', requestId: 'script-result', props: { title: '結果', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    for (const key of ['res-copy', 'res-save', 'res-rerun', 'res-claude']) expect([key, (await pane.find({ type: 'Button', key })) !== undefined]).toEqual([key, true])
    expect((await pane.find({ type: 'Markdown' }))?.text?.includes('| id | name |')).toBe(true)
    await pane.unmount()
  }
})

test('/wb-run：名前で選んで実行し、危険なものは実行しない', async ($, on) => {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'f750411 init\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.clock(on)
  on('state.get', seed({ scripts: { shape: 'scripts-1', value: SEED_SCRIPTS } }) as never)
  const ok = await $.command.run({ command: 'wb-run', args: 'git log: ' } as never)
  expect(calls).toEqual([['git', 'log', '--oneline', '-20']])
  expect(ok.text?.startsWith('git log: ✓ 1行')).toBe(true)
  const ng = await $.command.run({ command: 'wb-run', args: 'CSV を SQL で: drop table t' } as never)
  expect(calls.length).toBe(1)
  expect(ng.text?.includes('確認して実行')).toBe(true)
})

test('設定ペインのスクリプト欄と、レビュー指摘ペイン', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 42 }))
  on('state.get', seed({
    reviewDetail: 'r2',
    reviews: { shape: 'reviews-1', value: [
      { id: 'r2', model: 'gpt-x', effort: '', target: '未コミット差分', prompt: '', startedAt: 0, endedAt: 5000, status: 'done', isBackground: false, logFile: 'C:\\t\\r.txt',
        findings: [{ severity: 'P1', title: 'Null check missing', location: 'C:\\repo\\a.ts:10-12', body: 'When x is undefined this throws.' }] },
    ] },
  }) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = { plugin: 'work-band', surface, component: 'Pane', props: { title: 't', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const
    const s = await $.ui.mount({ ...pane, requestId: 'settings' })
    await s.press({ key: 'sc-seed' })
    expect((await s.find({ type: 'Input', key: 'sc-cmd-s-rg' })) !== undefined).toBe(true)
    expect((await s.find({ type: 'Button', key: 'up-git' }))?.text).toBe('↑')
    expect((await s.find({ type: 'Button', key: 'vis-script' }))?.text).toBe('表示中')
    await s.press({ key: 'sc-add' })
    expect((await s.find({ type: 'Text', text: /スクリプト · 4件/ })) !== undefined).toBe(true)
    await s.press({ key: 'sc-del-s42' })
    await s.unmount()
    const d = await $.ui.mount({ ...pane, requestId: 'review-detail' })
    expect((await d.find({ type: 'Text', text: /Null check missing/ }))?.text).toBe('Null check missing')
    expect((await d.find({ type: 'Text', text: /^Codex レビュー · / }))?.text).toBe('Codex レビュー · P1 1')
    await d.unmount()
  }
})
