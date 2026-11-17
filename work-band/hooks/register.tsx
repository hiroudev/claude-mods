import { atom, read, update } from 'claude-code'
import type {
  EngineInterface, Register, RenderChildren, RenderInput, SessionContextUsage, SessionRateLimit, ToolCallResult, TurnCompleteInput, TurnStartInput,
} from 'claude-code'

import type { Approval, Card, CodexJob, CtxRow, CtxView, ElementId, Finding, GitInfo, Layout, ReviewJob, Script, ScriptIcon, ScriptRun, Heavy, GptView, Limit, PromptEdits, Savings, UsageView } from '../types'
import { CODEX_FALLBACK, ICONS, wrapPng } from './icons'
import { applyEdits, moveKey, type PromptKey } from './prompts'
import { cacheRate, catColor, catLabel, collapse, CORE, COLLAPSE, C, ctxLevel, CTX_PANE, EMPTY, footerLine, forecast, fromCodexLog, KIND_LABEL, nextPerTurn, kTokens, rateLevel, shortModel, stackSvg, until, untilAuto, WINDOW_MS } from './usage'
import type { Sample } from './usage'

// 1本の帯（AbovePrompt）に Codex レビュー状況・Codex 依頼フォーム・依頼の進捗・承認待ち・Git の状態・
// 登録スクリプトの実行欄をまとめる。
// 帯の ⚙ で要素の並べ替えと表示/非表示、スクリプトの登録を変えられる（$.store に保存し全セッション共通）。
// スマホには帯が出ないので、スマホが繋がっている間だけ同じ内容をペイン（Mods シート）に出す。
// 完了したレビューと依頼はチャット末尾（$.ui.place）にカードで残す。長い内容（スクリプトの結果・レビュー指摘）はペインで開く。

const ALL: ElementId[] = ['approvals', 'review', 'git', 'icon', 'model', 'input', 'send', 'image', 'script', 'jobs', 'usage', 'prompts']
const DEFAULT_LAYOUT: Layout = { order: ALL, hidden: [] }
const NAMES: Record<ElementId, string> = {
  approvals: '承認待ち（複数セッション）',
  review: 'Codex レビュー状況',
  icon: 'Codex アイコン',
  model: 'モデル選択',
  input: '依頼の入力欄',
  send: '依頼ボタン',
  image: '画像生成ボタン',
  jobs: 'Codex 依頼の進捗',
  git: 'Git の状態',
  script: 'スクリプト実行',
  usage: 'Claude の利用状況',
  prompts: '保存プロンプト',
}
const INLINE = new Set<ElementId>(['icon', 'model', 'input', 'send', 'image'])
const PANE = 'work'
const SETTINGS = 'settings'
const RESULT = 'script-result'
const DETAIL = 'review-detail'
const HUB_TIMEOUT_SEC = 180
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'])
const REVIEW = /(?:codex(?:\.exe)?["']?|\$codex)\s+(?:exec\s+)?review\b/i

const layoutA = atom({ plugin: 'work-band', key: 'layout' } as const, DEFAULT_LAYOUT, { shape: 'layout-1' })
const editingA = atom({ plugin: 'work-band', key: 'isEditing' } as const, false)
const reviewsA = atom({ plugin: 'work-band', key: 'reviews' } as const, [], { shape: 'reviews-1' })
const jobsA = atom({ plugin: 'work-band', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const cardsA = atom({ plugin: 'work-band', key: 'cards' } as const, {}, { shape: 'cards-1' })
const modelA = atom({ plugin: 'work-band', key: 'model' } as const, '')
const draftA = atom({ plugin: 'work-band', key: 'draft' } as const, '')
const modelsA = atom({ plugin: 'work-band', key: 'models' } as const, [])
const nowA = atom({ plugin: 'work-band', key: 'now' } as const, 0)
const approvalsA = atom({ plugin: 'work-band', key: 'approvals' } as const, [], { shape: 'approvals-1' })
const hubOnA = atom({ plugin: 'work-band', key: 'hubOn' } as const, true)
const scriptsA = atom({ plugin: 'work-band', key: 'scripts' } as const, [], { shape: 'scripts-1' })
const scriptIdA = atom({ plugin: 'work-band', key: 'scriptId' } as const, '')
const scriptArgA = atom({ plugin: 'work-band', key: 'scriptArg' } as const, '')
const scriptRunA = atom({ plugin: 'work-band', key: 'scriptRun' } as const, null, { shape: 'run-1' })
const scriptConfirmA = atom({ plugin: 'work-band', key: 'scriptConfirm' } as const, null, { shape: 'confirm-1' })
const gitA = atom({ plugin: 'work-band', key: 'git' } as const, null, { shape: 'git-1' })
const reviewDetailA = atom({ plugin: 'work-band', key: 'reviewDetail' } as const, '')
const promptEditsA = atom({ plugin: 'work-band', key: 'promptEdits' } as const, {} as PromptEdits, { shape: 'prompts-1' })
const promptOrderA = atom({ plugin: 'work-band', key: 'promptOrder' } as const, [] as string[])
const gptA = atom({ plugin: 'work-band', key: 'gpt' } as const, { pair: {}, at: 0 } as GptView, { shape: 'gpt-1' })

export const SEED_SCRIPTS: Script[] = [
  { id: 's-rg', name: 'rg 検索', icon: 'search', template: 'rg -n --max-count 200 -e "{input}" {cwd}', dir: '' },
  { id: 's-gitlog', name: 'git log', icon: 'git', template: 'git log --oneline -20', dir: '' },
  { id: 's-csv', name: 'CSV を SQL で', icon: 'db', template: 'sqlite3 -header -csv -cmd ".import data.csv t" :memory: "{input}"', dir: '' },
]
const SCRIPT_ICONS: { value: ScriptIcon; label: string }[] = [
  { value: 'terminal', label: 'コマンド' },
  { value: 'search', label: '検索' },
  { value: 'git', label: 'Git' },
  { value: 'db', label: 'データベース' },
]

// ---- 純粋な関数（テスト対象） ----

export const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor(s / 60) % 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

export const normalize = (l: Layout): Layout => {
  const order = l.order.filter((id, i) => ALL.includes(id) && l.order.indexOf(id) === i)
  return { order: [...order, ...ALL.filter(id => !order.includes(id))], hidden: l.hidden.filter(id => ALL.includes(id)) }
}

export const move = (l: Layout, id: ElementId, by: -1 | 1): Layout => {
  const order = [...l.order]
  const i = order.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= order.length) return l
  ;[order[i], order[j]] = [order[j] as ElementId, order[i] as ElementId]
  return { ...l, order }
}

const tokens = (s: string) => {
  const out: string[] = []
  for (const m of s.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

// 依頼文の掃除：PowerShell のヒアストリング記号（@' '@ @" "@）と囲みの引用符を外し、空白をまとめる
export const cleanPrompt = (s: string) =>
  s
    .replace(/(^|\s)@['"](?=\s|$)|(^|\s)['"]@(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .trim()

// 帯に出す1文目（。or ". " まで、長ければ切る）
export const firstSentence = (s: string) => (/^.+?(?:。|\.(?=\s|$))/.exec(s)?.[0] ?? s).slice(0, 160)

export const parseReview = (cmd: string, defaults: { model: string; effort: string }) => {
  const m = REVIEW.exec(cmd)
  let rest = m === null ? '' : cmd.slice(m.index + m[0].length)
  // ヒアストリングは語に分ける前に取り出す（中の引用符で語の切れ目が崩れるため）
  const here = /@(['"])\r?\n([\s\S]*?)\r?\n\1@/.exec(rest)
  if (here !== null) rest = rest.replace(here[0], ' ')
  const t = tokens(rest)
  let { model, effort } = defaults
  let target = '未コミット差分'
  const prompt: string[] = []
  for (let i = 0; i < t.length; i++) {
    const a = t[i] ?? ''
    if (/^(\||2>&1|;|&&|\|\||>|>>)/.test(a)) break
    if (a === '-c' || a === '--config') {
      const kv = /^(model|model_reasoning_effort)\s*=\s*"?([^"]*)"?$/.exec(t[++i] ?? '')
      if (kv?.[1] === 'model') model = kv[2] ?? model
      else if (kv?.[1] === 'model_reasoning_effort') effort = kv[2] ?? effort
    } else if (a === '-m' || a === '--model') model = t[++i] ?? model
    else if (a === '--uncommitted') target = '未コミット差分'
    else if (a === '--base') target = `base: ${t[++i] ?? ''}`
    else if (a === '--commit') target = `commit: ${(t[++i] ?? '').slice(0, 8)}`
    else if (a === '--title') i++
    else if (!a.startsWith('-')) prompt.push(a)
  }
  // 全文は「詳細」ペインで見せるので長めに持つ
  return { model, effort, target, prompt: cleanPrompt(here?.[2] ?? prompt.join(' ')).slice(0, 4000) }
}

export const summarize = (input: unknown) => {
  const i = (input ?? {}) as Record<string, unknown>
  const s =
    typeof i.command === 'string' ? i.command
    : typeof i.file_path === 'string' ? i.file_path
    : typeof i.url === 'string' ? i.url
    : JSON.stringify(input) ?? ''
  return s.replace(/\s+/g, ' ').slice(0, 200)
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// ---- スクリプト：テンプレート展開 ----
// シェルを通さず argv で実行する。テンプレートを先に語に分け、語の中の {input} {cwd} を置き換えるので、
// 入力に空白や引用符があっても1つの引数のまま（別の引数・別のコマンドにならない）。
// 実行ファイルがシェル（PowerShell / bash / cmd）のときだけ、入力はシェルが解釈するので別の手当てをする。

type Expanded = { argv: string[]; env: Record<string, string> } | { error: string }

export const expandTemplate = (template: string, input: string, dir: string): Expanded => {
  const t = tokens(template)
  const exe = t[0]
  if (exe === undefined) return { error: 'コマンドが空です' }
  if (exe.includes('{input}')) return { error: '実行ファイルの位置に {input} は置けません' }
  const usesInput = t.some(a => a.includes('{input}'))
  if (usesInput && input.trim() === '') return { error: '入力欄が空です' }
  const shell = /^(powershell|pwsh|bash|sh|cmd)(?:\.exe)?$/i.exec(baseName(exe))?.[1]?.toLowerCase()
  const env: Record<string, string> = {}
  let value = input
  if (shell === 'powershell' || shell === 'pwsh') {
    // 値は環境変数で渡し、スクリプトには変数参照だけを書く（引用符を閉じて抜け出せない）
    env.WB_INPUT = input
    value = '$env:WB_INPUT'
  } else if (shell === 'bash' || shell === 'sh') {
    env.WB_INPUT = input
    value = '"$WB_INPUT"'
  } else if (shell === 'cmd' && /[&|<>^%!"()\r\n]/.test(input)) {
    return { error: 'cmd 経由のスクリプトには & | < > ^ % ! " ( ) を含む入力を渡せません' }
  }
  const argv = t.map((a, i) => {
    if (i > 0 && shell === undefined && a === '{input}' && input.startsWith('-')) {
      // 先頭が - の値はオプションとして読まれる（rg --pre=… など）。-e や -- の直後だけ許す
      const prev = t[i - 1] ?? ''
      if (!['-e', '--regexp', '--'].includes(prev) && !t.slice(0, i).includes('--')) return null
    }
    return a.replaceAll('{cwd}', dir).replaceAll('{input}', value)
  })
  if (argv.includes(null)) return { error: '「-」で始まる入力はオプション扱いになるため渡せません（テンプレートで -e や -- の後ろに置いてください）' }
  return { argv: argv as string[], env }
}

export const quoteForDisplay = (argv: readonly string[]) =>
  argv.map(a => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')

// 書き換え・削除をしそうなコマンド。mod からの実行は Claude の承認を通らないので、実行前に確認を挟む
const DANGER = /\b(update|delete|drop|insert|alter|truncate)\b|(?:^|[\s;&|("'])(rm|rmdir|del|erase|Remove-Item)(?=$|[\s;&|)"'])/i
export const isDangerous = (text: string) => DANGER.test(text)

// ---- CSV / TSV ----

export const parseCsv = (text: string, delim: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delim) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

// 先頭20行が同じ列数（2列以上）に揃っていれば表として扱う
export const detectDelim = (text: string): ',' | '\t' | '' => {
  const head = text.split(/\r?\n/).filter(l => l.trim() !== '').slice(0, 20).join('\n')
  for (const d of ['\t', ','] as const) {
    const rows = parseCsv(head, d)
    const n = rows[0]?.length ?? 0
    if (rows.length >= 2 && n >= 2 && rows.every(r => r.length === n)) return d
  }
  return ''
}

export const toMarkdownTable = (rows: string[][], limit = 200) => {
  const width = Math.max(...rows.map(r => r.length))
  const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') || ' '
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`
  const [head = [], ...body] = rows
  return [line(head), `|${' --- |'.repeat(width)}`, ...body.slice(0, limit).map(line)].join('\n')
}

// ---- Codex レビューの出力 ----

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

// 実行中に「今なにをしているか」を1行で。exec（コマンド実行）・codex / thinking（Codex の発言）の
// 最後のブロックを優先し、無ければ最後の空でない行
export const reviewProgress = (log: string) => {
  const lines = stripAnsi(log).split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = (lines[i] ?? '').trim()
    if (h !== 'exec' && h !== 'codex' && h !== 'thinking') continue
    const body = lines.slice(i + 1).map(s => s.trim()).find(s => s !== '')
    if (body === undefined) continue
    if (h !== 'exec') return body.slice(0, 200)
    const cmd = body
      .replace(/^"[^"]*"\s+(?:-Command\s+)?/i, '')
      .replace(/\s+in\s+\S+$/, '')
      .replace(/^"(.*)"$/, '$1')
    return `実行: ${cmd}`.slice(0, 200)
  }
  const last = lines.map(s => s.trim()).filter(s => s !== '' && !/^(succeeded|exited)\b/.test(s)).pop()
  return (last ?? '').slice(0, 200)
}

// `Full review comments:` 以降の `- [P1] 見出し — パス:行` と、続く説明行
export const parseFindings = (log: string): Finding[] => {
  const text = stripAnsi(log)
  const at = text.lastIndexOf('Full review comments:')
  if (at < 0) return []
  const out: Finding[] = []
  let cur: Finding | undefined
  for (const raw of text.slice(at).split(/\r?\n/).slice(1)) {
    const m = /^\s*[-*]\s*\[(P\d)\]\s*(.+?)\s*$/.exec(raw)
    if (m !== null) {
      const head = m[2] ?? ''
      const loc = /^(.*?)\s+[—–-]\s+(\S.*?:\d+(?:-\d+)?)$/.exec(head)
      cur = { severity: m[1] ?? '', title: loc?.[1] ?? head, location: loc?.[2] ?? '', body: '' }
      out.push(cur)
    } else if (cur !== undefined && raw.trim() !== '') cur.body = `${cur.body} ${raw.trim()}`.trim().slice(0, 2000)
  }
  const seen = new Set<string>()
  return out.filter(f => {
    const k = `${f.severity}|${f.title}|${f.location}`
    return seen.has(k) ? false : (seen.add(k), true)
  })
}

export const countFindings = (fs: readonly Finding[]) => {
  if (fs.length === 0) return '指摘なし'
  const by = new Map<string, number>()
  for (const f of fs) by.set(f.severity, (by.get(f.severity) ?? 0) + 1)
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => `${s} ${n}`).join(' · ')
}

// codex review のコマンドから Tee-Object / tee の出力先を取り出す
export const teePath = (cmd: string) => {
  const m = /(?:Tee-Object(?:\s+-(?:File)?Path)?|\|\s*tee(?:\s+-a)?)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|)]+))/i.exec(cmd)
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? ''
}

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(2)}秒` : fmt(ms))

export const runSummary = (r: ScriptRun, now: number) => {
  if (r.status === 'running') return `● 実行中 ${fmt(now - r.startedAt)}`
  const t = secs((r.endedAt ?? r.startedAt) - r.startedAt)
  if (r.status === 'done') return `✓ ${r.count}${r.delim === '' ? '行' : '件'}${r.isTruncated ? '+' : ''} · ${t}`
  return r.exitCode === null ? `✗ 起動できません · ${t}` : `✗ 終了コード ${r.exitCode} · ${r.count}行 · ${t}`
}

// ---- Git ----

export const parseGitStatus = (out: string): GitInfo => {
  const g: GitInfo = { branch: '', changes: 0, ahead: 0, behind: 0, hasUpstream: false }
  for (const l of out.split(/\r?\n/)) {
    if (l.startsWith('# branch.head ')) g.branch = l.slice(14).trim()
    else if (l.startsWith('# branch.upstream ')) g.hasUpstream = true
    else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(l)
      g.ahead = Number(m?.[1] ?? 0)
      g.behind = Number(m?.[2] ?? 0)
    } else if (l !== '' && !l.startsWith('#')) g.changes++
  }
  if (g.branch === '(detached)') g.branch = '（detached HEAD）'
  return g
}

// ---- 環境 ----

let defaults = { model: '', effort: '' }
let sessionId = ''
let sessionLabel = ''
let cwd = ''
let ticker: { cancel: () => void } | undefined
let tickCount = 0

const userHome = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? ''
const codexHome = async ($: EngineInterface) => (await $.env.get('CODEX_HOME')) ?? `${await userHome($)}\\.codex`
const hubDir = async ($: EngineInterface) => `${await userHome($)}\\.claude\\approval-hub`

const findCodex = async ($: EngineInterface) => {
  const bin = `${(await $.env.get('LOCALAPPDATA')) ?? ''}\\OpenAI\\Codex\\bin`
  let best = { path: '', mtimeMs: -1 }
  for (const d of await $.fs.list(bin).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const exe = `${bin}\\${d.name}\\codex.exe`
    const st = await $.fs.stat(exe).catch(() => undefined)
    if (st !== undefined && st.mtimeMs > best.mtimeMs) best = { path: exe, mtimeMs: st.mtimeMs }
  }
  return best.path
}

const loadCodexConfig = async ($: EngineInterface) => {
  const home = await codexHome($)
  const toml = await $.fs.read(`${home}\\config.toml`).catch(() => '')
  const text = typeof toml === 'string' ? toml : ''
  defaults = {
    model: /^model\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '',
    effort: /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '',
  }
  const cache = await $.fs.read(`${home}\\models_cache.json`).catch(() => '')
  let models: string[] = []
  try {
    const parsed = JSON.parse(typeof cache === 'string' ? cache : '{}') as { models?: { slug: string; visibility?: string }[] }
    models = (parsed.models ?? []).filter(m => m.visibility !== 'hide').map(m => m.slug)
  } catch {}
  if (defaults.model !== '' && !models.includes(defaults.model)) models.unshift(defaults.model)
  await update($, modelsA, () => models)
}

const ps = ($: EngineInterface, script: string, env: Record<string, string>, timeoutMs = 15_000) =>
  $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { env, timeoutMs })

const openPath = async ($: EngineInterface, path: string) => {
  const r = await ps($, 'Start-Process -FilePath $env:WB_PATH', { WB_PATH: path }).catch(() => undefined)
  if (r === undefined || r.exitCode !== 0) $.ui.toast(`開けませんでした: ${baseName(path)}`)
}

// Windows PowerShell 5.1 の Tee-Object は UTF-16 で書くので、NUL が混ざっていたら読み直す
const readLog = async ($: EngineInterface, path: string) => {
  const text = await $.fs.read(path).catch(() => '')
  if (typeof text !== 'string' || !text.includes('\u0000')) return typeof text === 'string' ? text : ''
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  const bytes = (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(base64)
  return new TextDecoder('utf-16le').decode(bytes).replace(/^﻿/, '')
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

// ---- Git の状態（ターン終了時と1分ごと） ----

const refreshGit = async ($: EngineInterface) => {
  const r = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { cwd, timeoutMs: 10_000 }).catch(() => undefined)
  const next = r === undefined || r.exitCode !== 0 ? null : parseGitStatus(r.stdout)
  if (JSON.stringify(next) !== JSON.stringify(await read($, gitA))) await update($, gitA, () => next)
}

// ---- スクリプト実行 ----

const setScripts = async ($: EngineInterface, fn: (l: Script[]) => Script[]) => {
  const next = fn(await read($, scriptsA))
  await update($, scriptsA, () => next)
  await $.store.set('scripts', next)
}

const runScript = async ($: EngineInterface, opts: { scriptId?: string; input?: string; isConfirmed?: boolean } = {}) => {
  const scripts = await read($, scriptsA)
  const id = opts.scriptId ?? ((await read($, scriptIdA)) || scripts[0]?.id)
  const s = scripts.find(x => x.id === id)
  if (s === undefined) return $.ui.toast('スクリプトが登録されていません（⚙ から登録できます）')
  if ((await read($, scriptRunA))?.status === 'running') return $.ui.toast('スクリプトを実行中です')
  const input = opts.input ?? (await read($, scriptArgA))
  const dir = s.dir.trim() || cwd
  const x = expandTemplate(s.template, input, cwd)
  if ('error' in x) return $.ui.toast(x.error)
  if (opts.isConfirmed !== true && isDangerous(`${x.argv.join(' ')} ${input}`)) {
    await update($, scriptConfirmA, () => ({ scriptId: s.id, input }))
    return
  }
  await update($, scriptConfirmA, () => null)
  const startedAt = await $.clock.now()
  const run: ScriptRun = {
    scriptId: s.id, name: s.name, icon: s.icon, input, command: quoteForDisplay(x.argv), dir,
    startedAt, endedAt: null, status: 'running', exitCode: null, output: '', stderr: '', delim: '', count: 0, isTruncated: false,
  }
  await update($, scriptRunA, () => run)
  await update($, nowA, () => startedAt)
  ensureTicker($)
  let done: ScriptRun
  try {
    // 作業フォルダが空欄なら cwd を渡さない（$.process.run の既定がセッションのフォルダ）
    const r = await $.process.run(x.argv, { ...(s.dir.trim() !== '' ? { cwd: s.dir.trim() } : {}), env: x.env, timeoutMs: 120_000 })
    // ponytail: 状態に持つのは先頭 300k 文字まで。全文が要る用途が出たら一時ファイルに書いて開く
    const output = r.stdout.slice(0, 300_000)
    const delim = detectDelim(output)
    const rows = delim === '' ? output.split(/\r?\n/).filter(l => l.trim() !== '').length : Math.max(0, parseCsv(output, delim).length - 1)
    done = {
      ...run, endedAt: await $.clock.now(), status: r.exitCode === 0 ? 'done' : 'failed', exitCode: r.exitCode,
      output, stderr: r.stderr.slice(0, 20_000), delim, count: rows, isTruncated: r.isStdoutTruncated || r.stdout.length > output.length,
    }
  } catch (e) {
    const msg = String(e)
    done = { ...run, endedAt: await $.clock.now(), status: 'failed', stderr: /ENOENT|not found|cannot start|spawn/i.test(msg) ? `起動できません: ${x.argv[0]}\n${msg}` : msg }
  }
  await update($, scriptRunA, () => done)
}

const resultText = (r: ScriptRun) => r.output + (r.stderr !== '' ? `${r.output === '' ? '' : '\n'}${r.stderr}` : '')

const saveResult = async ($: EngineInterface, r: ScriptRun) => {
  const ext = r.delim === ',' ? 'csv' : r.delim === '\t' ? 'tsv' : 'txt'
  const path = `${await userHome($)}\\Downloads\\work-band\\${r.name.replace(/[\\/:*?"<>|\s]+/g, '_')}-${stamp(r.startedAt)}.${ext}`
  await $.fs.write(path, resultText(r))
  $.ui.toast(`保存しました: ${path}`)
}

const sendToClaude = async ($: EngineInterface, r: ScriptRun) => {
  const body = resultText(r)
  const cut = body.length > 20_000 ? `${body.slice(0, 20_000)}\n…（以下 ${body.length - 20_000} 文字省略）` : body
  await $.prompt.submit({ text: `スクリプト「${r.name}」の実行結果（終了コード ${r.exitCode ?? '-'}）:\n\n$ ${r.command}\n\n\`\`\`\n${cut}\n\`\`\`` })
}

const openResult = async ($: EngineInterface) => {
  const r = await read($, scriptRunA)
  const opened = await $.ui.open({ id: RESULT, title: `結果: ${r?.name ?? ''}`, focus: true }).catch(() => undefined)
  if (opened?.isPlaced === true || r === null) return
  // ペインを出せない画面では一時ファイルにして既定のアプリで開く
  const path = `${(await $.env.get('TEMP')) ?? cwd}\\work-band\\result-${stamp(r.startedAt)}.txt`
  await $.fs.write(path, resultText(r))
  await openPath($, path)
}

// ---- Codex レビュー（帯のボタンから起動） ----

const liveLogs = new Map<string, string>()

const startReview = async ($: EngineInterface) => {
  if ((await read($, reviewsA)).some(r => r.status === 'running')) return $.ui.toast('Codex レビューを実行中です')
  const git = await read($, gitA)
  if (git !== null && git.changes === 0) return $.ui.toast('レビューする未コミットの変更がありません')
  const codex = await findCodex($)
  if (codex === '') return $.ui.toast('codex.exe が見つかりません（%LOCALAPPDATA%\\OpenAI\\Codex\\bin）')
  const now = await $.clock.now()
  const model = (await read($, modelA)) || defaults.model
  const job: ReviewJob = {
    id: `r${now}`, model, effort: defaults.effort, target: '未コミット差分', prompt: '', startedAt: now, endedAt: null,
    status: 'running', isBackground: false, isMod: true, logFile: `${(await $.env.get('TEMP')) ?? cwd}\\work-band\\r${now}-review.txt`,
  }
  await update($, reviewsA, l => [...l, job].slice(-5))
  await update($, nowA, () => now)
  ensureTicker($)
  void (async () => {
    const argv = [codex, 'review', '--uncommitted']
    if (model !== '') argv.push('-c', `model="${model}"`)
    let log = ''
    let code: number | null = null
    liveLogs.set(job.id, '')
    try {
      const it = $.process.spawn({ argv, cwd })[Symbol.asyncIterator]()
      for (;;) {
        const r = await it.next()
        if (r.done === true) {
          code = r.value.code
          break
        }
        log = (log + r.value.text).slice(-2_000_000)
        liveLogs.set(job.id, log)
      }
    } catch (e) {
      log += `\n${String(e)}`
    }
    await $.fs.write(job.logFile as string, log).catch(() => undefined)
    await finishReview($, job.id, code !== 0)
    void refreshGit($)
  })()
}

const refreshReviewProgress = async ($: EngineInterface) => {
  for (const r of await read($, reviewsA)) {
    if (r.status !== 'running') continue
    const log = liveLogs.get(r.id) ?? (r.logFile ? await readLog($, r.logFile) : '')
    const progress = reviewProgress(log.slice(-65_536))
    if (progress !== '' && progress !== r.progress) await update($, reviewsA, l => l.map(x => (x.id === r.id ? { ...x, progress } : x)))
  }
}

// ---- 時計（実行中・承認待ちがある間だけ1秒ごとに進める） ----

const ensureTicker = ($: EngineInterface) => {
  if (ticker !== undefined) return
  ticker = $.clock.every(1000, () => {
    void tick($)
  })
}

const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, nowA, () => now)
  const reviews = await read($, reviewsA)
  // 終わったレビューは指摘を「詳細」で開けるよう10分残す
  const keep = reviews.filter(r => r.endedAt === null || now - r.endedAt < 600_000)
  if (keep.length !== reviews.length) await update($, reviewsA, () => keep)
  tickCount += 1
  if (tickCount % 5 === 0 && keep.some(r => r.status === 'running' && r.isBackground)) await checkBackgroundReviews($)
  if (tickCount % 3 === 0 && keep.some(r => r.status === 'running')) await refreshReviewProgress($)
  const jobs = await read($, jobsA)
  const busy =
    keep.length > 0 ||
    jobs.some(j => j.status === 'running' || now - (j.endedAt ?? now) < 300_000) ||
    (await read($, approvalsA)).length > 0 ||
    (await read($, scriptRunA))?.status === 'running'
  if (!busy) {
    ticker?.cancel()
    ticker = undefined
  }
}

// ---- Codex レビュー検知 ----

const checkBackgroundReviews = async ($: EngineInterface) => {
  const r = await ps(
    $,
    "@(Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | Where-Object { $_.CommandLine -match '\\sreview(\\s|$)' }).Count",
    {},
  ).catch(() => undefined)
  if (r === undefined || r.exitCode !== 0 || Number(r.stdout.trim()) > 0) return
  for (const x of (await read($, reviewsA)).filter(x => x.status === 'running' && x.isBackground)) await finishReview($, x.id, false)
}

const finishReview = async ($: EngineInterface, id: string, failed: boolean) => {
  const now = await $.clock.now()
  const r = (await read($, reviewsA)).find(x => x.id === id)
  if (r === undefined) return
  const log = liveLogs.get(id) ?? (r.logFile ? await readLog($, r.logFile) : '')
  liveLogs.delete(id)
  const findings = parseFindings(log).slice(0, 50)
  const done: ReviewJob = {
    ...r, status: failed ? 'failed' : 'done', endedAt: now, findings,
    progress: failed ? reviewProgress(log.slice(-65_536)) : r.progress,
  }
  await update($, reviewsA, l => l.map(x => (x.id === id ? done : x)))
  await placeCard($, `rv${id}`, { kind: 'review', review: done })
}

// $.env.get は名前を直書きする決まりなので、パスに出てきそうな変数だけ展開する
const resolvePath = async ($: EngineInterface, p: string) => {
  const vars: Record<string, string | undefined> = {
    TEMP: await $.env.get('TEMP'), TMP: await $.env.get('TMP'), USERPROFILE: await $.env.get('USERPROFILE'), LOCALAPPDATA: await $.env.get('LOCALAPPDATA'),
  }
  const out = p.replace(/\$env:(\w+)|%(\w+)%/gi, (m, a?: string, b?: string) => vars[(a ?? b ?? '').toUpperCase()] ?? m)
  return /^([A-Za-z]:|[\\/])/.test(out) ? out : `${cwd}\\${out}`
}

const openDetail = async ($: EngineInterface, id: string) => {
  await update($, reviewDetailA, () => id)
  const opened = await $.ui.open({ id: DETAIL, title: 'Codex レビューの指摘', focus: true }).catch(() => undefined)
  const r = (await read($, reviewsA)).find(x => x.id === id)
  if (opened?.isPlaced !== true && r?.logFile) await openPath($, r.logFile)
}

// ---- チャット末尾カード ----

const placeCard = async ($: EngineInterface, id: string, card: Card) => {
  await update($, cardsA, all => Object.fromEntries([...Object.entries(all).slice(-39), [id, card]]))
  await $.ui.place({ id })
}

// ---- Codex 依頼 ----

const IMAGE_PROMPT = (text: string) =>
  `次の内容で画像を1枚生成してください。生成した画像は作業フォルダの codex-images フォルダに PNG でも保存し、最後に保存したファイルのパスを1行で返答してください。\n\n${text}`

const startJob = async ($: EngineInterface, kind: CodexJob['kind'], typed?: string) => {
  const prompt = (typed ?? (await read($, draftA))).trim()
  if (prompt === '') return $.ui.toast('依頼内容を入力してください')
  if ((await read($, jobsA)).some(j => j.status === 'running')) return $.ui.toast('Codex の依頼を実行中です。終わってから次を送れます')
  const codex = await findCodex($)
  if (codex === '') return $.ui.toast('codex.exe が見つかりません（%LOCALAPPDATA%\\OpenAI\\Codex\\bin）')
  const now = await $.clock.now()
  const id = `j${now}`
  const outFile = `${(await $.env.get('TEMP')) ?? cwd}\\work-band\\${id}.md`
  await $.fs.write(outFile, '')
  const job: CodexJob = {
    id, kind, prompt, outFile,
    model: (await read($, modelA)) || defaults.model,
    startedAt: now, endedAt: null, status: 'running', result: '', images: [],
  }
  await update($, jobsA, l => [...l, job].slice(-5))
  await update($, draftA, () => '')
  ensureTicker($)
  void runCodex($, job, codex)
}

const runCodex = async ($: EngineInterface, job: CodexJob, codex: string) => {
  const argv = [codex, 'exec', '--json', '-s', 'workspace-write', '--skip-git-repo-check', '--color', 'never', '-C', cwd, '-o', job.outFile]
  if (job.model !== '') argv.push('-m', job.model)
  argv.push(job.kind === 'image' ? IMAGE_PROMPT(job.prompt) : job.prompt)
  let head = ''
  let err = ''
  let code: number | null = null
  try {
    const it = $.process.spawn({ argv, cwd })[Symbol.asyncIterator]()
    for (;;) {
      const r = await it.next()
      if (r.done === true) {
        code = r.value.code
        break
      }
      if (r.value.stream === 'stdout' && head.length < 8192) head += r.value.text
      if (r.value.stream === 'stderr') err = (err + r.value.text).slice(-2000)
    }
  } catch (e) {
    err = String(e)
  }
  const thread = /"thread_id"\s*:\s*"([^"]+)"/.exec(head)?.[1]
  const out = await $.fs.read(job.outFile).catch(() => '')
  const images: string[] = []
  if (thread !== undefined) {
    const dir = `${await codexHome($)}\\generated_images\\${thread}`
    for (const f of await $.fs.list(dir).catch(() => [])) if (f.kind === 'file') images.push(`${dir}\\${f.name}`)
  }
  const done: CodexJob = {
    ...job,
    status: code === 0 ? 'done' : 'failed',
    endedAt: await $.clock.now(),
    result: (typeof out === 'string' && out.trim() !== '' ? out : err).slice(0, 20_000),
    images,
  }
  await update($, jobsA, l => l.map(j => (j.id === job.id ? done : j)))
  await placeCard($, `jb${job.id}`, { kind: 'job', job: done })
  $.ui.toast(done.status === 'done' ? 'Codex の依頼が完了しました' : 'Codex の依頼が失敗しました')
}

const handToClaude = async ($: EngineInterface, job: CodexJob) => {
  const imgs = job.images.length > 0 ? `\n\n生成画像:\n${job.images.join('\n')}` : ''
  await $.prompt.fill({ text: `Codex（${job.model}）への依頼「${job.prompt.slice(0, 80)}」の回答:\n\n${job.result}${imgs}\n\n`, mode: 'insert' })
  $.ui.toast('入力欄に差し込みました。確認して送信してください')
}

// ---- 承認ハブ ----

const pollHub = async ($: EngineInterface) => {
  const dir = `${await hubDir($)}\\pending`
  const now = await $.clock.now()
  const list: Approval[] = []
  for (const f of await $.fs.list(dir).catch(() => [])) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    const text = await $.fs.read(`${dir}\\${f.name}`).catch(() => '')
    try {
      const a = JSON.parse(typeof text === 'string' ? text : '') as Approval
      if (a.timeoutAt + 5000 > now) list.push(a)
    } catch {}
  }
  list.sort((a, b) => a.createdAt - b.createdAt)
  const before = await read($, approvalsA)
  if (JSON.stringify(before) !== JSON.stringify(list)) await update($, approvalsA, () => list)
  if (list.length > 0) ensureTicker($)
}

const decide = async ($: EngineInterface, keys: string[], answer: 'allow' | 'deny' | 'dialog') => {
  const dir = `${await hubDir($)}\\decisions`
  for (const key of keys) await $.fs.write(`${dir}\\${key}.json`, JSON.stringify({ key, answer }))
  await update($, approvalsA, l => l.filter(a => !keys.includes(a.key)))
}

// 応答ファイルを待つ。見つかったら要求IDを照合して返し、要求と応答のファイルを消す。
const WAIT = `$p=$env:WB_PENDING; $d=$env:WB_DECISION; $k=$env:WB_KEY; $lim=[int]$env:WB_TIMEOUT
$sw=[Diagnostics.Stopwatch]::StartNew()
try {
  while ($sw.Elapsed.TotalSeconds -lt $lim) {
    if (Test-Path -LiteralPath $d) {
      try { $j = Get-Content -Raw -LiteralPath $d | ConvertFrom-Json } catch { $j = $null }
      if ($j -and $j.key -eq $k) { Write-Output $j.answer; exit 0 }
      Remove-Item -LiteralPath $d -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 400
  }
  Write-Output 'timeout'
} finally { Remove-Item -LiteralPath $p, $d -ErrorAction SilentlyContinue }`

const waitDecision = async ($: EngineInterface, a: Approval) => {
  const hub = await hubDir($)
  const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WAIT]
  const env = {
    WB_PENDING: `${hub}\\pending\\${a.key}.json`,
    WB_DECISION: `${hub}\\decisions\\${a.key}.json`,
    WB_KEY: a.key,
    WB_TIMEOUT: String(HUB_TIMEOUT_SEC),
  }
  let out = ''
  for await (const c of $.process.spawn({ argv, env })) if (c.stream === 'stdout') out += c.text
  return out.trim()
}

// ---- スマホ用ペイン ----

const syncPane = async ($: EngineInterface) => {
  const isMobile = (await $.session.surfaces()).includes('mobile')
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isMobile && !isOpen) await $.ui.open({ id: PANE, title: 'Codex・承認' })
  if (!isMobile && isOpen) await $.ui.close({ id: PANE })
}

const setLayout = async ($: EngineInterface, fn: (l: Layout) => Layout) => {
  const next = normalize(fn(normalize(await read($, layoutA))))
  await update($, layoutA, () => next)
  await $.store.set('layout', next)
}

// ---- 描画 ----

// 要素ごとのアイコン（色付き角丸タイル + 白い線画）。ターミナルは色付きの記号で代用
// アイコンは背景なしの線画（Codex 作）。色は文字色に近い1色で、状態を示すときだけ差し色を使う
type Glyph = ElementId | ScriptIcon | 'hub' | 'gear'
const ICON_OF: Record<Glyph, keyof typeof ICONS | 'codex'> = {
  approvals: 'approvals', review: 'review', icon: 'codex', model: 'model', input: 'input',
  send: 'send', image: 'image', jobs: 'jobs', hub: 'hub', gear: 'gear',
  script: 'terminal', terminal: 'terminal', search: 'search', git: 'git', db: 'db', usage: 'gauge', prompts: 'recommend',
}
const MARK: Record<Glyph, string> = {
  approvals: '◆', review: '◉', icon: '◎', model: '▣', input: '✎', send: '➤', image: '▨', jobs: '◔', hub: '≡', gear: '⚙',
  script: '›', terminal: '›', search: '⌕', git: '⎇', db: '≣', usage: '◔', prompts: '✓',
}
const ALT: Record<Glyph, string> = {
  approvals: '承認待ち', review: 'Codex レビュー', icon: 'Codex', model: 'モデル', input: '入力', send: '依頼', image: '画像生成',
  jobs: 'Codex 依頼', hub: '承認ハブ', gear: '設定', script: 'スクリプト', terminal: 'コマンド', search: '検索', git: 'Git', db: 'データベース', usage: '利用状況', prompts: '保存プロンプト',
}
export const INK = { base: '#C9CBD1', off: '#5F636B', accent: '#E0A64A' }
const DOT = { running: INK.accent, done: '#6FBF73', failed: '#E06C6C' } as const
const iconSvg = (g: Glyph, color: string) => {
  const key = ICON_OF[g]
  return key === 'codex' ? (codexLogo ?? CODEX_FALLBACK.replace(/\{\{c\}\}/g, color)) : ICONS[key].replace(/\{\{c\}\}/g, color)
}

// Codex デスクトップアプリ（MSIX）が入っていれば、その公式アイコンを読む。画像はリポジトリに含めない
let codexLogo: string | undefined
const loadCodexLogo = async ($: EngineInterface) => {
  if (codexLogo !== undefined) return
  const r = await ps($, "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation", {}).catch(() => undefined)
  const dir = r?.exitCode === 0 ? r.stdout.trim() : ''
  if (dir === '') return
  const png = await $.fs.read(`${dir}\\assets\\Square44x44Logo.targetsize-48_altform-unplated.png`, { as: 'bytes' }).catch(() => undefined)
  if (png === undefined) return
  codexLogo = wrapPng(png.base64)
  $.ui.invalidate('ui.render')
}

const DESC: Record<ElementId, string> = {
  approvals: '各セッションの承認依頼をここで許可・拒否',
  review: '実行中の codex review の進み具合と、終わった後の指摘件数',
  git: 'ブランチ・未コミット件数・ahead/behind と Codex レビュー起動',
  script: '登録したスクリプト（検索・SQL など）を実行して結果を見る',
  icon: '依頼フォームの先頭に付く目印',
  model: 'Codex に使うモデルを切り替え',
  input: 'Codex への依頼文を入力',
  send: '入力欄の右端を「依頼」にする（非表示なら ↵）',
  image: '入力した内容で画像を生成',
  jobs: 'Codex への依頼の実行状況',
  usage: 'コンテキスト使用率・利用枠のペース・キャッシュ・前ターン。多いときは圧縮・引き継ぎ',
  prompts: '推奨・日本語・新規・図解・引継ぎ・圧縮・画像・お気に入り2つ（文は下で変更）',
}

type Draw = RenderInput<'AbovePrompt' | 'Pane' | 'Placed'>

// ---- 保存プロンプト（アイコン＋全角2文字の見出しの行。押すとすぐ送る。入力中の下書きがあれば前に付けて送る） ----
// Button の中には SVG を入れられないため、見出しの plain Button の先頭の空白にアイコンを重ねる。
// position absolute の要素はポインターを受けず下へ通すので、アイコンを押すと下の Button に届く（逆に重ねると押せない）。

async function sendSaved($: EngineInterface, text: string) {
  const draft = (await $.prompt.read()).text.trim()
  if (draft !== '') await $.prompt.fill({ text: '' })
  await $.prompt.submit({ text: draft === '' ? text : `${draft}\n\n${text}` })
}

async function pressPrompt($: EngineInterface, key: PromptKey) {
  if (key === 'compact') return compactNow($)
  if (key === 'newSession') return handoff($)
  if (key === 'image') return imageFromPrompt($)
  const p = (await promptList($)).find(x => x.key === key)
  if (p?.text === undefined) return
  if (p.text.trim() === '') {
    // お気に入りが未登録：設定を開いて登録してもらう
    $.ui.toast(`「${p.short}」のプロンプトが未登録です。帯の設定で登録してください`)
    return openSettings($)
  }
  await sendSaved($, p.text)
}

// 画像：入力欄に書いた内容で Codex に画像を生成させる（入力欄は空にする）。入力欄が空なら Codex 依頼欄の内容を使う
async function imageFromPrompt($: EngineInterface) {
  const draft = (await $.prompt.read()).text.trim()
  if (draft === '') return startJob($, 'image')
  await $.prompt.fill({ text: '' })
  await startJob($, 'image', draft)
}

async function setPromptEdits($: EngineInterface, f: (l: PromptEdits) => PromptEdits) {
  const next = f(await read($, promptEditsA))
  await update($, promptEditsA, () => next)
  await $.store.set('promptEdits', next)
}

async function setPromptOrder($: EngineInterface, next: string[]) {
  await update($, promptOrderA, () => next)
  await $.store.set('promptOrder', next)
}

async function promptList($: EngineInterface) {
  return applyEdits(await read($, promptEditsA), await read($, promptOrderA))
}

async function drawPrompts($: EngineInterface, e: Draw) {
  const ui = $.ui.resolve(e)
  const { Box, Button } = ui
  const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
  return (
    <Box key="prompts" flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
      {(await promptList($)).map(p =>
        Svg === undefined ? (
          // ターミナルは SVG を描けないので記号1文字
          <Button key={`pr-${p.key}`} plain dimColor label={`${p.mark}${p.short}`} onPress={() => void pressPrompt($, p.key)} />
        ) : (
          // Button には SVG を入れられないので、見出しの先頭に全角空白を空け、そこへアイコンを重ねる。
          // 重ねた要素はポインターを下へ通すので、アイコンの上も見出しの上も同じ1つのボタンとして押せる。
          // alt を空にするとアイコンが描かれなかったので、必ず名前を入れる。見出しはどれも全角2文字で、幅は全部同じ
          <Box key={`pr-${p.key}`} flexDirection="row" alignItems="center">
            <Button key={`prb-${p.key}`} plain label={`　${p.short}`} onPress={() => void pressPrompt($, p.key)} />
            <Box position="absolute" top={0} left={1}>
              <Svg source={ICONS[p.key].replace(/\{\{c\}\}/g, INK.base)} alt={p.name} width={16} height={16} />
            </Box>
          </Box>
        ),
      )}
    </Box>
  )
}

// 設定はペインで開く（帯は高さが限られるため）。ペインを出せない画面では帯の中で編集する
const openSettings = async ($: EngineInterface) => {
  const opened = await $.ui.open({ id: SETTINGS, title: '帯のカスタマイズ', focus: true }).catch(() => undefined)
  if (opened?.isPlaced !== true) await update($, editingA, () => true)
}

const closeSettings = async ($: EngineInterface) => {
  await update($, editingA, () => false)
  await $.ui.close({ id: SETTINGS }).catch(() => undefined)
}

const drawWork = async ($: EngineInterface, e: Draw, isPane: boolean, isSettings = false) => {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button, Input, Select } = ui
  // ターミナルの表にも Svg はあるが空の箱になるので、記号で代用する
  const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
  const layout = normalize(await read($, layoutA))
  const now = Math.max(await read($, nowA), 0)
  const isEditing = isSettings || (!isPane && (await read($, editingA)))
  const tile = (g: Glyph, size = 18, isOff = false, color?: string, alt = ALT[g]) =>
    Svg !== undefined ? (
      <Svg source={iconSvg(g, color ?? (isOff ? INK.off : INK.base))} alt={alt} width={size} height={size} />
    ) : (
      <Text color={color} dimColor={isOff || color === undefined}>
        {MARK[g]}
      </Text>
    )
  const card = { backgroundColor: 'rgba(127,127,127,0.08)', paddingX: 1, paddingY: Svg !== undefined ? 'xs' : 0 } as const
  const scripts = await read($, scriptsA)

  if (isEditing) {
    const hubOn = await read($, hubOnA)
    const last = layout.order.length - 1
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
            {tile('gear', 22)}
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text weight="semibold">帯のカスタマイズ</Text>
              <Text dimColor size="caption" wrap="truncate-end">
                並び順と表示を選べます · 全セッション共通
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key="reset" plain dimColor label="↺ 初期値" onPress={() => void setLayout($, () => DEFAULT_LAYOUT)} />
            <Button key="done" variant="primary" label="完了" onPress={() => void closeSettings($)} />
          </Box>
        </Box>
        <Text dimColor size="caption" weight="medium">
          表示する要素 · {layout.order.length - layout.hidden.length}/{layout.order.length}
        </Text>
        {layout.order.map((id, i) => {
          const isHidden = layout.hidden.includes(id)
          return (
            <Box
              key={`e-${id}`}
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              gap={1}
              {...card}
              hover={Svg !== undefined ? { backgroundColor: 'rgba(127,127,127,0.16)' } : undefined}
            >
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
                <Text dimColor tabular size="caption">
                  {String(i + 1).padStart(2, ' ')}
                </Text>
                {tile(id, 20, isHidden)}
                <Box flexDirection="column" flexShrink={1} minWidth={0}>
                  <Text weight="semibold" dimColor={isHidden} wrap="truncate-end">
                    {NAMES[id]}
                  </Text>
                  <Text dimColor size="caption" wrap="truncate-end">
                    {DESC[id]}
                  </Text>
                </Box>
              </Box>
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                {/* デスクトップは label を文字として出すので、矢印は label に入れる */}
                <Button key={`up-${id}`} plain dimColor={i === 0} label="↑" onPress={() => void setLayout($, l => move(l, id, -1))} />
                <Button key={`dn-${id}`} plain dimColor={i === last} label="↓" onPress={() => void setLayout($, l => move(l, id, 1))} />
                <Button
                  key={`vis-${id}`}
                  variant={isHidden ? 'secondary' : 'primary'}
                  label={isHidden ? '非表示' : '表示中'}
                  onPress={() =>
                    void setLayout($, l => ({ ...l, hidden: isHidden ? l.hidden.filter(x => x !== id) : [...l.hidden, id] }))
                  }
                />
              </Box>
            </Box>
          )
        })}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text dimColor size="caption" weight="medium">
            保存プロンプト
          </Text>
          <Button
            key="pe-reset"
            plain
            dimColor
            label="↺ すべて初期値"
            onPress={() => void setPromptEdits($, () => ({})).then(() => setPromptOrder($, []))}
          />
        </Box>
        <Text dimColor size="caption" wrap="wrap">
          ↑↓ で帯に並ぶ順番を変えられます。名前は全角2文字にすると、帯のボタンの幅がそろいます。押すとすぐ送信します（入力中の文があれば、その後ろに付けて送ります）
        </Text>
        {(await promptList($)).map((p, i, list) => {
          const order = list.map(x => x.key)
          const edit = (patch: { short?: string; text?: string }) =>
            void setPromptEdits($, l => ({ ...l, [p.key]: { ...l[p.key], ...patch } }))
          return (
            <Box key={`pe-${p.key}`} flexDirection="column" rowGap={1} {...card}>
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
                  <Text dimColor tabular size="caption">
                    {String(i + 1).padStart(2, ' ')}
                  </Text>
                  {Svg !== undefined ? (
                    <Svg source={ICONS[p.key].replace(/\{\{c\}\}/g, INK.base)} alt={p.name} width={20} height={20} />
                  ) : (
                    <Text dimColor>{p.mark}</Text>
                  )}
                  <Text weight="semibold" wrap="truncate-end">
                    {p.short} <Text dimColor>· {p.name}</Text>
                  </Text>
                </Box>
                <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                  <Button key={`pe-up-${p.key}`} plain dimColor={i === 0} label="↑" onPress={() => void setPromptOrder($, moveKey(order, p.key, -1))} />
                  <Button key={`pe-dn-${p.key}`} plain dimColor={i === list.length - 1} label="↓" onPress={() => void setPromptOrder($, moveKey(order, p.key, 1))} />
                </Box>
              </Box>
              {/* 文を送るもの（お気に入りを含む）だけ名前と文を変えられる。新規・圧縮・画像は並び順だけ */}
              {/* Input の label は文字の長さで枠の位置がずれるので、同じ幅の見出しを自前で置いて枠の左端をそろえる。枠は残りの幅いっぱい */}
              {p.text !== undefined ? (
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Box width={10} flexShrink={0}>
                    <Text dimColor>名前</Text>
                  </Box>
                  <Box flexGrow={1} minWidth={8}>
                    <Input key={`pe-short-${p.key}`} value={p.short} onInput={(v: string) => edit({ short: v })} onSubmit={(v: string) => edit({ short: v })} />
                  </Box>
                </Box>
              ) : null}
              {p.text !== undefined ? (
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Box width={10} flexShrink={0}>
                    <Text dimColor>プロンプト</Text>
                  </Box>
                  <Box flexGrow={1} minWidth={16}>
                    <Input
                      key={`pe-text-${p.key}`}
                      placeholder="押したときに送る文"
                      value={p.text}
                      onInput={(v: string) => edit({ text: v })}
                      onSubmit={(v: string) => edit({ text: v })}
                    />
                  </Box>
                </Box>
              ) : null}
            </Box>
          )
        })}
        <Text dimColor size="caption" weight="medium">
          承認ハブ
        </Text>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} {...card}>
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
            {tile('hub', 20, !hubOn)}
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text weight="semibold">複数セッションの承認をまとめる</Text>
              <Text dimColor size="caption" wrap="truncate-end">
                オフにすると各セッションの通常の確認ダイアログに戻ります
              </Text>
            </Box>
          </Box>
          <Button
            key="hub"
            variant={hubOn ? 'primary' : 'secondary'}
            label={hubOn ? 'オン' : 'オフ'}
            onPress={() =>
              void (async () => {
                await update($, hubOnA, () => !hubOn)
                await $.store.set('hubOn', !hubOn)
              })()
            }
          />
        </Box>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text dimColor size="caption" weight="medium">
            スクリプト · {scripts.length}件
          </Text>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key="sc-seed" plain dimColor label="↺ 例を追加" onPress={() => void setScripts($, l => [...l, ...SEED_SCRIPTS.filter(s => !l.some(x => x.id === s.id))])} />
            <Button
              key="sc-add"
              label="＋ 追加"
              onPress={() =>
                void $.clock.now().then(t => setScripts($, l => [...l, { id: `s${t}`, name: '新しいスクリプト', icon: 'terminal', template: '', dir: '' }]))
              }
            />
          </Box>
        </Box>
        <Text dimColor size="caption" wrap="wrap">
          {'{input}'} = 帯の入力欄、{'{cwd}'} = セッションのフォルダ。シェルを通さず実行し、{'{input}'} は1つの引数として渡します。作業フォルダが空欄ならセッションのフォルダ
        </Text>
        {scripts.map(s => {
          const edit = (patch: Partial<Script>) => void setScripts($, l => l.map(x => (x.id === s.id ? { ...x, ...patch } : x)))
          return (
            <Box key={`sc-${s.id}`} flexDirection="column" rowGap={1} {...card}>
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
                  {tile(s.icon, 20)}
                  <Text weight="semibold" wrap="truncate-end">
                    {s.name || '（名前なし）'}
                  </Text>
                </Box>
                <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                  <Select key={`sc-icon-${s.id}`} label="アイコン" options={SCRIPT_ICONS} value={s.icon} onSelect={(v: string) => edit({ icon: v as ScriptIcon })} />
                  <Button key={`sc-del-${s.id}`} plain dimColor label="削除" onPress={() => void setScripts($, l => l.filter(x => x.id !== s.id))} />
                </Box>
              </Box>
              <Input key={`sc-name-${s.id}`} label="名前" value={s.name} onInput={(v: string) => edit({ name: v })} onSubmit={(v: string) => edit({ name: v })} />
              <Input
                key={`sc-cmd-${s.id}`}
                label="コマンド"
                placeholder={'例: rg -n -e "{input}" {cwd}'}
                value={s.template}
                onInput={(v: string) => edit({ template: v })}
                onSubmit={(v: string) => edit({ template: v })}
              />
              <Input
                key={`sc-dir-${s.id}`}
                label="作業フォルダ"
                placeholder="空欄ならセッションのフォルダ"
                value={s.dir}
                onInput={(v: string) => edit({ dir: v })}
                onSubmit={(v: string) => edit({ dir: v })}
              />
            </Box>
          )
        })}
        {await drawSavings($, e)}
      </Box>
    )
  }

  const usageRow = layout.hidden.includes('usage') ? null : await drawUsage($, e)
  const promptsRow = layout.hidden.includes('prompts') ? null : await drawPrompts($, e)
  const reviews = await read($, reviewsA)
  const jobs = (await read($, jobsA)).filter(j => j.status === 'running' || now - (j.endedAt ?? now) < 300_000)
  const approvals = await read($, approvalsA)
  const models = await read($, modelsA)
  const model = (await read($, modelA)) || defaults.model || models[0] || ''
  const draft = await read($, draftA)
  const isRunning = jobs.some(j => j.status === 'running')
  const git = await read($, gitA)
  const scriptId = await read($, scriptIdA)
  const scriptArg = await read($, scriptArgA)
  const run = await read($, scriptRunA)
  const confirm = await read($, scriptConfirmA)
  // 状態は文字を出さず色付きの●だけ。状態名は Svg の alt に残す（読み上げ用）
  const dot = (s: 'running' | 'done' | 'failed') =>
    Svg !== undefined ? (
      <Svg
        source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="${DOT[s]}"/></svg>`}
        alt={s === 'running' ? '実行中' : s === 'done' ? '完了' : '失敗'}
        width={8}
        height={8}
      />
    ) : (
      <Text color={s === 'failed' ? 'error' : s === 'done' ? 'success' : 'warning'}>●</Text>
    )
  const status = (s: 'running' | 'done' | 'failed', ms: number) => (
    <Text color={s === 'failed' ? 'error' : s === 'done' ? 'success' : 'warning'} tabular weight="medium">
      {s === 'running' ? `● 実行中 ${fmt(ms)}` : s === 'done' ? `✓ 完了 ${fmt(ms)}` : '✕ 失敗'}
    </Text>
  )

  const parts: Record<ElementId, () => RenderChildren | null> = {
    icon: () => tile('icon', 20),
    model: () => (
      <Select
        key="model"
        options={(models.length > 0 ? models : [model || 'default']).map(m => ({ value: m, label: m }))}
        value={model || undefined}
        onSelect={(v: string) => void update($, modelA, () => v).then(() => $.store.set('model', v))}
      />
    ),
    input: () => (
      <Box flexGrow={1} minWidth={16}>
        <Input
          key="draft"
          placeholder="Codex への依頼内容"
          value={draft}
          // デスクトップでは枠付き Button だけ入力欄より高く描かれるので、依頼は入力欄の送信チップにする（高さが揃う）
          submitLabel={layout.hidden.includes('send') ? '↵' : isRunning ? '実行中…' : '依頼'}
          onInput={(v: string) => void update($, draftA, () => v)}
          onSubmit={(v: string) => void startJob($, 'task', v)}
        />
      </Box>
    ),
    // 依頼ボタンは入力欄の送信チップに含めた（表示切替は送信チップの文字「依頼」/「↵」）
    send: () => null,
    image: () => (
      <Box key="image-wrap" flexDirection="row" alignItems="center" gap={1}>
        {tile('image', 16)}
        <Button key="image" plain label="画像生成" onPress={() => void startJob($, 'image')} />
      </Box>
    ),
    review: () =>
      reviews.length === 0
        ? null
        : reviews.slice(-2).map(r => {
            const isDone = r.status === 'done'
            const findings = r.findings ?? []
            const worst = findings.map(f => f.severity).sort()[0]
            const line = r.status === 'running' && r.progress ? r.progress : firstSentence(r.prompt)
            // 1行に収める：固定部品（ロゴ・●経過時間・モデル・対象）は縮めず、依頼文／進捗だけを末尾で切る
            return (
              <Box key={`rv-${r.id}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexGrow={1} {...card}>
                <Box flexShrink={0}>{tile('icon', 16, false, undefined, 'Codex レビュー')}</Box>
                <Box flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
                  {dot(r.status)}
                  <Text tabular weight="medium" wrap="truncate">
                    {fmt((r.endedAt ?? now) - r.startedAt)}
                  </Text>
                </Box>
                {isDone ? (
                  <Box flexShrink={0}>
                    <Text weight="medium" tabular wrap="truncate" color={worst === 'P0' || worst === 'P1' ? 'error' : worst === undefined ? undefined : 'warning'} dimColor={worst === undefined}>
                      {countFindings(findings)}
                    </Text>
                  </Box>
                ) : null}
                <Box flexShrink={0}>
                  <Text dimColor size="caption" wrap="truncate">
                    {[r.model, r.effort].filter(Boolean).join(' ')}
                  </Text>
                </Box>
                <Box flexShrink={0} backgroundColor="rgba(127,127,127,0.16)" paddingX={1}>
                  <Text size="caption" wrap="truncate">
                    {r.target}
                  </Text>
                </Box>
                <Box flexShrink={1} flexGrow={1} minWidth={0}>
                  <Text wrap="truncate-end" dimColor>
                    {line}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Button key={`rv-detail-${r.id}`} plain dimColor={r.status === 'running'} label="詳細" onPress={() => void openDetail($, r.id)} />
                </Box>
              </Box>
            )
          }),
    git: () =>
      git === null ? null : (
        <Box key="git" flexDirection="row" alignItems="center" gap={1} flexGrow={1} {...card}>
          {tile('git', 16)}
          <Box flexShrink={1} minWidth={0}>
            <Text weight="semibold" wrap="truncate-middle">
              {git.branch}
            </Text>
          </Box>
          <Text tabular color={git.changes > 0 ? 'warning' : undefined} dimColor={git.changes === 0}>
            未コミット {git.changes}
          </Text>
          <Text tabular dimColor>
            {git.hasUpstream ? `↑${git.ahead} ↓${git.behind}` : '上流なし'}
          </Text>
          <Box flexGrow={1} />
          <Button
            key="git-review"
            label={reviews.some(r => r.status === 'running') ? 'レビュー中…' : 'Codex でレビュー'}
            onPress={() => void startReview($)}
          />
        </Box>
      ),
    script: () => {
      if (scripts.length === 0)
        return (
          <Box key="script" flexDirection="row" alignItems="center" gap={1} flexGrow={1} {...card}>
            {tile('script', 16, true)}
            <Text dimColor>スクリプトが未登録です</Text>
            <Box flexGrow={1} />
            <Button key="script-setup" label="登録する" onPress={() => void openSettings($)} />
          </Box>
        )
      const sel = scripts.find(s => s.id === scriptId) ?? (scripts[0] as Script)
      const usesInput = sel.template.includes('{input}')
      const isBusy = run?.status === 'running'
      return (
        <Box key="script" flexDirection="row" alignItems="center" gap={1} flexGrow={1} flexWrap="wrap" {...card}>
          {tile(sel.icon, 16)}
          <Select
            key="script-pick"
            options={scripts.map(s => ({ value: s.id, label: s.name || '（名前なし）' }))}
            value={sel.id}
            onSelect={(v: string) => void update($, scriptIdA, () => v).then(() => $.store.set('scriptId', v))}
          />
          <Box flexGrow={1} minWidth={16}>
            <Input
              key="script-arg"
              placeholder={usesInput ? '検索語・SQL など（{input}）' : '入力なしで実行できます'}
              value={scriptArg}
              submitLabel={isBusy ? '実行中…' : '実行'}
              onInput={(v: string) => void update($, scriptArgA, () => v)}
              onSubmit={(v: string) => void runScript($, { scriptId: sel.id, input: v })}
            />
          </Box>
          {confirm !== null ? (
            <Box key="script-confirm-wrap" flexDirection="row" alignItems="center" gap={1}>
              <Text color="warning" weight="medium">
                {scripts.find(s => s.id === confirm.scriptId)?.name ?? ''} は書き換え・削除を含みます
              </Text>
              <Button key="script-confirm" variant="primary" label="確認して実行" onPress={() => void runScript($, { ...confirm, isConfirmed: true })} />
              <Button key="script-cancel" plain dimColor label="取消" onPress={() => void update($, scriptConfirmA, () => null)} />
            </Box>
          ) : null}
          {run !== null ? (
            <Box key="script-sum" flexDirection="row" alignItems="center" gap={1}>
              <Text tabular weight="medium" color={run.status === 'failed' ? 'error' : run.status === 'done' ? 'success' : 'warning'}>
                {runSummary(run, now)}
              </Text>
              {run.status !== 'running' ? <Button key="script-open" plain label="結果" onPress={() => void openResult($)} /> : null}
            </Box>
          ) : null}
        </Box>
      )
    },
    usage: () => usageRow,
    prompts: () => promptsRow,
    jobs: () =>
      jobs.length === 0
        ? null
        : jobs.slice(-2).map(j => (
            <Box key={`jb-${j.id}`} flexDirection="row" alignItems="center" gap={1} flexGrow={1} {...card}>
              {tile(j.kind === 'image' ? 'image' : 'icon', 16)}
              <Text weight="semibold">{j.kind === 'image' ? '画像生成' : 'Codex 依頼'}</Text>
              {status(j.status, (j.endedAt ?? now) - j.startedAt)}
              <Text dimColor>{j.model}</Text>
              <Box flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">{j.prompt}</Text>
              </Box>
            </Box>
          )),
    approvals: () => {
      if (approvals.length === 0) return isPane ? <Text dimColor>承認待ちはありません</Text> : null
      const groups = [...new Set(approvals.map(a => a.sessionId))]
      return (
        <Box key="appr" flexDirection="column" rowGap={1} flexGrow={1} {...card}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Box flexDirection="row" alignItems="center" gap={1}>
              {tile('approvals', 18, false, INK.accent)}
              <Text color="permission" weight="semibold">
                承認待ち {approvals.length}件
              </Text>
            </Box>
            <Button key="deny-all" plain dimColor label="すべて拒否" onPress={() => void decide($, approvals.map(a => a.key), 'deny')} />
          </Box>
          {groups.map(sid => {
            const items = approvals.filter(a => a.sessionId === sid)
            const first = items[0] as Approval
            return (
              <Box key={`g-${sid}`} flexDirection="column" rowGap={1}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text dimColor wrap="truncate-end">
                    ▸ {first.label || baseName(first.cwd)}（{baseName(first.cwd)}）{sid === sessionId ? ' · このセッション' : ''}
                  </Text>
                  {items.length > 1 ? (
                    <Button key={`allow-${sid}`} label={`このセッションを全許可(${items.length})`} onPress={() => void decide($, items.map(a => a.key), 'allow')} />
                  ) : null}
                </Box>
                {items.map(a => (
                  <Box key={`a-${a.key}`} flexDirection="row" alignItems="center" gap={1}>
                    <Box flexDirection="row" gap={1} flexShrink={0}>
                      <Button key={`ok-${a.key}`} variant="primary" label="許可" onPress={() => void decide($, [a.key], 'allow')} />
                      <Button key={`ng-${a.key}`} label="拒否" onPress={() => void decide($, [a.key], 'deny')} />
                      <Button key={`dl-${a.key}`} dimColor label="ダイアログで" onPress={() => void decide($, [a.key], 'dialog')} />
                    </Box>
                    <Text dimColor tabular>{fmt(a.timeoutAt - now)}</Text>
                    <Box flexShrink={1} minWidth={0}>
                      <Text wrap="truncate-end">
                        <Text weight="semibold">{a.tool}</Text> {a.summary}
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            )
          })}
        </Box>
      )
    },
  }

  // 連続する部品（アイコン〜画像生成）は1行にまとめ、それ以外は行として積む
  const rows: RenderChildren[][] = []
  let inline: RenderChildren[] | null = null
  let formRow: RenderChildren[] | undefined
  for (const id of layout.order) {
    if (layout.hidden.includes(id)) continue
    const node = parts[id]()
    if (node === null) continue
    if (INLINE.has(id)) {
      if (inline === null) {
        inline = []
        rows.push(inline)
        formRow ??= inline
      }
      inline.push(node)
    } else {
      inline = null
      rows.push([node])
    }
  }
  // ⚙ は入力フォームの行の右端（フォームを全部隠したら最後の行の右端）
  const gear = (
    <Button key="gear" plain dimColor label={'⚙︎'} onPress={() => void openSettings($)} />
  )
  const host = formRow ?? rows[rows.length - 1]
  if (host === undefined) rows.push([gear])
  else host.push(<Box key="spacer" flexGrow={1} />, gear)

  // 依頼フォームの行だけカード地にする（承認・レビュー・進捗は各自カード地を持つ）
  return (
    <Box flexDirection="column" rowGap={1}>
      {rows.map((r, i) => (
        <Box key={`row${i}`} flexDirection="row" alignItems="center" gap={1} {...(r === formRow ? card : {})}>
          {r}
        </Box>
      ))}
    </Box>
  )
}

// スクリプトの結果ペイン：見出し・操作ボタン・本文（CSV/TSV は表、それ以外はコード）
const drawResult = async ($: EngineInterface, e: Draw) => {
  const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
  const r = await read($, scriptRunA)
  const confirm = await read($, scriptConfirmA)
  const now = Math.max(await read($, nowA), 0)
  if (r === null) return <Text dimColor>まだスクリプトを実行していません</Text>
  const rows = r.delim === '' ? [] : parseCsv(r.output, r.delim)
  const isBusy = r.status === 'running'
  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text weight="semibold" wrap="truncate-end">
            {r.name}
          </Text>
          <Text tabular weight="medium" color={r.status === 'failed' ? 'error' : r.status === 'done' ? 'success' : 'warning'}>
            {runSummary(r, now)}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Button
            key="res-copy"
            label="コピー"
            onPress={press =>
              void $.ui.copy({ text: resultText(r), surface: press.surface }).then(c => $.ui.toast(c.isCopied ? 'コピーしました' : 'コピーできませんでした'))
            }
          />
          <Button key="res-save" label="保存" onPress={() => void saveResult($, r)} />
          <Button key="res-rerun" label={isBusy ? '実行中…' : '再実行'} onPress={() => void runScript($, { scriptId: r.scriptId, input: r.input })} />
          <Button key="res-claude" variant="primary" label="Claudeへ" onPress={() => void sendToClaude($, r)} />
        </Box>
      </Box>
      {confirm !== null ? (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text color="warning" weight="medium">
            書き換え・削除を含みます
          </Text>
          <Button key="res-confirm" variant="primary" label="確認して実行" onPress={() => void runScript($, { ...confirm, isConfirmed: true })} />
          <Button key="res-cancel" plain dimColor label="取消" onPress={() => void update($, scriptConfirmA, () => null)} />
        </Box>
      ) : null}
      <Text dimColor size="caption" wrap="truncate-middle">
        $ {r.command}
      </Text>
      <Text dimColor size="caption" wrap="truncate-middle">
        {r.dir}
      </Text>
      {rows.length > 1 ? (
        <Markdown text={toMarkdownTable(rows) + (rows.length > 201 ? `\n\n…ほか ${rows.length - 201} 行（全体は「保存」）` : '')} />
      ) : r.output !== '' ? (
        <Code source={r.output.length > 60_000 ? `${r.output.slice(0, 60_000)}\n…（続きは「保存」）` : r.output} />
      ) : (
        <Text dimColor>{isBusy ? '実行中…' : '（出力なし）'}</Text>
      )}
      {r.isTruncated ? <Text color="warning">出力が大きいため先頭だけ保持しています</Text> : null}
      {r.stderr !== '' ? (
        <Box flexDirection="column">
          <Text dimColor size="caption" weight="medium">
            標準エラー
          </Text>
          <Code source={r.stderr} />
        </Box>
      ) : null}
    </Box>
  )
}

// Codex レビューの指摘ペイン
const drawDetail = async ($: EngineInterface, e: Draw) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const id = await read($, reviewDetailA)
  const r = (await read($, reviewsA)).find(x => x.id === id) ?? Object.values(await read($, cardsA)).flatMap(c => (c.kind === 'review' && c.review.id === id ? [c.review] : []))[0]
  if (r === undefined) return <Text dimColor>レビューが見つかりません（10分を過ぎると帯から消えます）</Text>
  const findings = r.findings ?? []
  const root = (await read($, gitA)) === null ? '' : cwd
  const rel = (p: string) => (root !== '' && p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length).replace(/^[\\/]/, '') : p)
  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text weight="semibold">Codex レビュー · {countFindings(findings)}</Text>
          <Text dimColor size="caption" wrap="truncate-end">
            {r.model + (r.effort ? ` · ${r.effort}` : '')} · {r.target} · {fmt((r.endedAt ?? r.startedAt) - r.startedAt)}
          </Text>
        </Box>
        {r.logFile ? <Button key="dt-log" label="ログを開く" onPress={() => void openPath($, r.logFile as string)} /> : null}
      </Box>
      <Box flexDirection="column" backgroundColor="rgba(127,127,127,0.08)" paddingX={1}>
        <Text dimColor size="caption" weight="medium">
          依頼内容 · {r.target}
        </Text>
        <Text wrap="wrap">{r.prompt || '（追加の指示なし）'}</Text>
      </Box>
      {r.status === 'running' ? (
        <Text dimColor wrap="wrap">
          実行中 {fmt(Math.max(await read($, nowA), r.startedAt) - r.startedAt)} · {r.progress || '開始しています…'}
        </Text>
      ) : findings.length === 0 ? (
        <Text dimColor>{r.status === 'failed' ? `失敗しました: ${r.progress ?? ''}` : '「Full review comments:」の指摘はありませんでした'}</Text>
      ) : (
        findings.map((f, i) => (
          <Box key={`f${i}`} flexDirection="column" backgroundColor="rgba(127,127,127,0.08)" paddingX={1}>
            <Box flexDirection="row" gap={1}>
              <Text weight="semibold" color={f.severity === 'P0' || f.severity === 'P1' ? 'error' : f.severity === 'P2' ? 'warning' : undefined}>
                {f.severity}
              </Text>
              <Text weight="semibold" wrap="wrap">
                {f.title}
              </Text>
            </Box>
            {f.location !== '' ? (
              <Text dimColor size="caption" wrap="truncate-middle">
                {rel(f.location)}
              </Text>
            ) : null}
            {f.body !== '' ? <Text wrap="wrap">{f.body}</Text> : null}
          </Box>
        ))
      )}
    </Box>
  )
}

const drawCard = async ($: EngineInterface, e: Draw, card: Card) => {
  const { Box, Text, Button, Markdown } = $.ui.resolve(e)
  if (card.kind === 'review') {
    const r = card.review
    return (
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="row" gap={1}>
        <Text color={r.status === 'failed' ? 'error' : 'success'}>{r.status === 'failed' ? '✕ Codex レビュー失敗' : '✓ Codex レビュー完了'}</Text>
        <Text tabular>{fmt((r.endedAt ?? r.startedAt) - r.startedAt)}</Text>
        {r.findings !== undefined ? <Text weight="medium">{countFindings(r.findings)}</Text> : null}
        <Text dimColor wrap="truncate-end">
          {r.model + (r.effort ? ` · ${r.effort}` : '')} · {r.target}
          {r.prompt ? ` — ${firstSentence(r.prompt)}` : ''}
        </Text>
      </Box>
    )
  }
  const j = card.job
  return (
    <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text color={j.status === 'failed' ? 'error' : 'success'} weight="semibold">
          {j.status === 'failed' ? '✕ Codex 失敗' : j.kind === 'image' ? '✓ Codex 画像生成' : '✓ Codex 回答'}
          <Text dimColor> {fmt((j.endedAt ?? j.startedAt) - j.startedAt)} · {j.model}</Text>
        </Text>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Button key="hand" variant="primary" label="Claude に渡す" onPress={() => void handToClaude($, j)} />
          <Button key="full" label="全文" onPress={() => void openPath($, j.outFile)} />
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">依頼: {j.prompt}</Text>
      <Markdown text={j.result.length > 1500 ? `${j.result.slice(0, 1500)}\n\n…（続きは「全文」）` : j.result || '（回答なし）'} />
      {j.images.map((p, i) => (
        <Box key={`img${i}`} flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-middle">{baseName(p)}</Text>
          <Button key={`open${i}`} plain label="↗" onPress={() => void openPath($, p)} />
        </Box>
      ))}
    </Box>
  )
}

// ---- Claude の利用状況（$ を使う部分。純粋な部分は usage.ts） ----

const usageA = atom({ plugin: 'work-band', key: 'usage' } as const, EMPTY, { shape: 'usage-1' })
const heavyA = atom({ plugin: 'work-band', key: 'heavy' } as const, [], { shape: 'heavy-1' })
const sectionsA = atom({ plugin: 'work-band', key: 'sections' } as const, [], { shape: 'sections-1' })
const ctxA = atom({ plugin: 'work-band', key: 'ctx' } as const, null, { shape: 'ctx-1' })
const savingsA = atom({ plugin: 'work-band', key: 'savings' } as const, { collapse: false, dropped: [] }, { shape: 'savings-1' })

// ---- 計測 ----

const samples = new Map<string, { resetsAt: number | null; pts: Sample[] }>()

async function setUsage($: EngineInterface, fn: (u: UsageView) => UsageView) {
  const before = await read($, usageA)
  const next = fn(before)
  if (JSON.stringify(next) === JSON.stringify(before)) return
  await update($, usageA, () => next)
}

// ---- GPT（Codex）の利用枠：Codex の rollout ログの最後の rate_limits を1分ごとに読む ----
let gptFile = { path: '', mtimeMs: 0 }

// sessions/YYYY/MM/DD/*.jsonl を新しい順に最大 limit 件
async function newestCodexLogs($: EngineInterface, root: string, limit: number) {
  const dirs = async (p: string) => (await $.fs.list(p).catch(() => [])).filter(e => e.kind === 'dir').map(e => e.name).sort().reverse()
  const out: { path: string; mtimeMs: number }[] = []
  for (const y of await dirs(root))
    for (const m of await dirs(`${root}\\${y}`))
      for (const d of await dirs(`${root}\\${y}\\${m}`)) {
        const dir = `${root}\\${y}\\${m}\\${d}`
        const files = (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'file' && e.name.endsWith('.jsonl')).sort((a, b) => b.mtimeMs - a.mtimeMs)
        for (const f of files) {
          out.push({ path: `${dir}\\${f.name}`, mtimeMs: f.mtimeMs })
          if (out.length >= limit) return out
        }
      }
  return out
}

async function refreshGpt($: EngineInterface) {
  const now = await $.clock.now()
  for (const log of await newestCodexLogs($, `${await codexHome($)}\\sessions`, 5)) {
    if (log.path === gptFile.path && log.mtimeMs === gptFile.mtimeMs) break
    const text = await $.fs.read(log.path).catch(() => '')
    const pair = fromCodexLog(typeof text === 'string' ? text : '')
    if (pair !== undefined) {
      gptFile = log
      await update($, gptA, () => ({ pair, at: now }))
      return
    }
  }
  // 値が同じでも残り時間（分）は進むので、時刻だけ更新して下部バーを描き直す
  await update($, gptA, g => ({ ...g, at: now }))
}

async function applyMeasure($: EngineInterface, context: SessionContextUsage, rateLimits: readonly SessionRateLimit[]) {
  const now = await $.clock.now()
  const limits = rateLimits.map((r): Limit => {
    const resetsAt = r.resetsAt === undefined ? null : Date.parse(r.resetsAt) || null
    let s = samples.get(r.kind)
    if (s === undefined || s.resetsAt !== resetsAt) samples.set(r.kind, (s = { resetsAt, pts: [] }))
    s.pts = [...s.pts.filter(p => p.t >= now - 2 * 3600_000), { t: now, pct: r.percentUsed }]
    return { kind: r.kind, pct: r.percentUsed, resetsAt, hitAt: forecast({ pct: r.percentUsed, now, resetsAt, windowMs: WINDOW_MS[r.kind], samples: s.pts }) }
  })
  const model = await $.session.model().catch(() => '')
  await setUsage($, u => ({ ...u, tokens: context.tokens ?? null, window: context.window, pct: context.percent ?? null, limits, model: model || u.model }))
}

async function refresh($: EngineInterface) {
  const u = await $.session.usage()
  await applyMeasure($, u.context, u.rateLimits)
}

// 内訳（/context と同じ区分。summary はローカルの見積もりで API を呼ばない）
async function refreshCtx($: EngineInterface) {
  const b = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context.breakdown
  if (b === undefined) return
  const mcp = new Map<string, number>()
  for (const t of b.mcpTools) if (t.isLoaded) mcp.set(t.serverName, (mcp.get(t.serverName) ?? 0) + t.tokens)
  const top = (rows: CtxRow[]) => rows.sort((a, z) => z.tokens - a.tokens).slice(0, 8)
  const view: CtxView = {
    used: top(b.categories.filter(c => c.kind === 'used').map(c => ({ label: c.name, tokens: c.tokens }))),
    free: b.categories.find(c => c.kind === 'free')?.tokens ?? 0,
    memory: top(b.memoryFiles.map(f => ({ label: f.path, tokens: f.tokens }))),
    mcp: top([...mcp].map(([label, tokens]) => ({ label, tokens }))),
    skills: b.skills?.tokens ?? 0,
    autoCompactAt: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
    max: b.rawMaxTokens,
  }
  await update($, ctxA, () => view)
}

const labelOf = (i: Record<string, unknown>) => {
  const v = i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.prompt ?? i.description
  return (typeof v === 'string' ? v : JSON.stringify(i) ?? '').replace(/\s+/g, ' ').slice(0, 160)
}

async function noteHeavy($: EngineInterface, h: Heavy) {
  if (h.chars < 4000) return
  await update($, heavyA, l => [...l, h].sort((a, z) => z.chars - a.chars).slice(0, 10))
}

// ---- 片付け ----

const focusOf = (prompt: string) =>
  prompt === '' ? '未完了の作業・決定事項・変更したファイルを優先して残す' : `今の作業（${prompt.slice(0, 200)}）を続けるのに必要なこと・未完了の作業・決定事項・変更したファイルを優先して残す`

let lastPrompt = ''
// 前の往復が終わったときのコンテキスト量（1往復の増え方を測る）
let turnTokens: number | null = null

async function compactNow($: EngineInterface) {
  if ((await read($, usageA)).busy !== '') return
  await setUsage($, u => ({ ...u, busy: 'compact' }))
  try {
    const r = (await $.session.compact({ instructions: focusOf(lastPrompt) })) as { skip?: unknown; tokensBefore?: number; tokensAfter?: number }
    if (r.skip !== undefined) $.ui.toast('圧縮は取り消されました')
    else $.ui.toast(r.tokensBefore !== undefined && r.tokensAfter !== undefined ? `圧縮しました（${kTokens(r.tokensBefore)} → ${kTokens(r.tokensAfter)}）` : '圧縮しました')
    await update($, heavyA, () => [])
  } catch {
    $.ui.toast('応答の途中は圧縮できません。応答が終わってから押してください')
  } finally {
    await setUsage($, u => ({ ...u, busy: '' }))
    void refresh($)
  }
}

const HANDOFF =
  'この会話を新しいセッションで続けるための引き継ぎメモを書いてください。ツールは使わず、メモの本文だけを出力してください。' +
  '含めるもの: 目的 / 終わったこと（変更したファイルのパス） / 決めたことと理由 / 未完了の作業と次の一手 / 注意点。1500字以内、箇条書き。'

// 引き継ぎメモを今の会話から作り（キャッシュを読む fork）、/clear してから入力欄に入れる。送信は人が確認してから
async function handoff($: EngineInterface) {
  if ((await read($, usageA)).busy !== '') return
  await setUsage($, u => ({ ...u, busy: 'handoff' }))
  try {
    const r = await $.model.fork({ prompt: HANDOFF })
    if (!r.isAnswered) return $.ui.toast(`引き継ぎメモを作れませんでした（${r.reason}）`)
    const text = `前のセッションからの引き継ぎです。内容を確認して作業を続けてください。\n\n${r.text.trim()}\n`
    const canClear = (await $.command.list()).some(c => c.name === 'clear')
    const cleared = canClear && (await $.command.run({ command: 'clear' }).then(() => true, () => false))
    await $.prompt.fill({ text })
    $.ui.toast(cleared ? '新しい会話にしました。入力欄の引き継ぎメモを確認して送信してください' : '会話をクリアできなかったため、引き継ぎメモを入力欄に入れました（/clear してから送信してください）')
    await update($, heavyA, () => [])
  } finally {
    await setUsage($, u => ({ ...u, busy: '' }))
    void refresh($)
  }
}

async function openContext($: EngineInterface) {
  await refreshCtx($)
  const opened = await $.ui.open({ id: CTX_PANE, title: 'コンテキストの内訳', focus: true }).catch(() => undefined)
  if (opened?.isPlaced === true) return
  const c = await read($, ctxA)
  $.ui.toast(c === null ? '内訳を取得できませんでした' : `使用: ${c.used.slice(0, 3).map(r => `${r.label} ${kTokens(r.tokens)}`).join(' / ')}`)
}

async function setSavings($: EngineInterface, fn: (s: Savings) => Savings) {
  const next = fn(await read($, savingsA))
  await update($, savingsA, () => next)
  await $.store.set('savings', next)
}

// ---- 描画 ----

const LV_COLOR = { ok: C.base, warn: C.warn, danger: C.danger } as const
const LV_TEXT = { ok: undefined, warn: 'warning', danger: 'error' } as const

async function drawUsage($: EngineInterface, e: Draw) {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
  const u = await read($, usageA)
  const now = u.limits.length > 0 ? await $.clock.now() : 0
  const lv = ctxLevel(u.pct)
  const card = { backgroundColor: 'rgba(127,127,127,0.08)', paddingX: 1, paddingY: Svg !== undefined ? 'xs' : 0 } as const
  const fill = Math.min(1, (u.pct ?? 0) / 100)
  const bar =
    Svg !== undefined ? (
      <Svg
        source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 6"><rect width="48" height="6" rx="3" fill="${C.off}" opacity=".45"/><rect width="${Math.max(fill * 48, u.pct === null ? 0 : 3).toFixed(1)}" height="6" rx="3" fill="${LV_COLOR[lv]}"/></svg>`}
        alt={u.pct === null ? 'コンテキスト 未計測' : `コンテキスト ${u.pct}%`}
        width={48}
        height={6}
      />
    ) : (
      <Text color={LV_TEXT[lv]} dimColor={lv === 'ok'}>
        {'▰'.repeat(Math.round(fill * 8)) + '▱'.repeat(8 - Math.round(fill * 8))}
      </Text>
    )
  // 1w は他でも見られるので出さない
  const hot = u.limits.filter(l => l.kind !== 'seven_day' && rateLevel(l, now) !== 'ok')
  const busy = u.busy
  // ふだんの数値は下部バー（ステータス行）に出す。帯にはしきい値を超えたときだけ、ボタンと一緒に出す
  if (lv === 'ok' && hot.length === 0 && busy === '') return null
  const c = await read($, ctxA)
  const left = untilAuto(c?.autoCompactAt ?? null, u.tokens)
  const quiet = [left !== null ? `自動圧縮まで ${kTokens(left)}` : ''].filter(Boolean)
  return (
    <Box key="usage" flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexGrow={1} {...card}>
      <Box flexShrink={0}>
        {Svg !== undefined ? (
          <Svg source={ICONS.gauge.replace(/\{\{c\}\}/g, LV_COLOR[lv])} alt="Claude の利用状況" width={16} height={16} />
        ) : (
          <Text color={LV_TEXT[lv]} dimColor={lv === 'ok'}>
            ◔
          </Text>
        )}
      </Box>
      <Box flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
        <Text tabular weight="medium" color={LV_TEXT[lv]} wrap="truncate">
          {u.pct === null ? 'コンテキスト —' : `コンテキスト ${u.pct}%`}
        </Text>
        {bar}
        {u.tokens !== null ? (
          <Text dimColor size="caption" tabular wrap="truncate">
            {kTokens(u.tokens)}/{kTokens(u.window)}
          </Text>
        ) : null}
      </Box>
      {hot.map(l => (
        <Box key={`lim-${l.kind}`} flexShrink={0}>
          <Text tabular weight="medium" color={LV_TEXT[rateLevel(l, now)]} wrap="truncate">
            {KIND_LABEL[l.kind] ?? l.kind} {Math.round(l.pct)}%{l.hitAt !== null ? ` · 上限 ${until(l.hitAt - now)}` : ''}
          </Text>
        </Box>
      ))}
      <Box flexShrink={1} flexGrow={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">
          {quiet.join(' · ')}
        </Text>
      </Box>
      {lv !== 'ok' || busy !== '' ? (
        <Box flexShrink={0} flexDirection="row" gap={1}>
          <Button key="u-compact" variant={lv === 'danger' ? 'primary' : undefined} label={busy === 'compact' ? '圧縮中…' : '要約して圧縮'} onPress={() => void compactNow($)} />
          <Button key="u-handoff" label={busy === 'handoff' ? '引き継ぎを作成中…' : '新規セッションで続ける'} onPress={() => void handoff($)} />
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Button key="u-detail" plain dimColor label="内訳" onPress={() => void openContext($)} />
      </Box>
    </Box>
  )
}

// 内訳ペイン：帯に出ている使用率と圧縮・引き継ぎのボタンは繰り返さず、
// 何が場所を取っているか（区分の積み上げ）・圧縮で要約に置き換わるもの・外せるものだけを出す
async function drawContext($: EngineInterface, e: Draw) {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
  const u = await read($, usageA)
  const c = await read($, ctxA)
  const heavy = await read($, heavyA)
  const sections = await read($, sectionsA)
  const { dropped } = await read($, savingsA)
  const card = { backgroundColor: 'rgba(127,127,127,0.08)', paddingX: 1 } as const
  const head = (title: string, note?: string) => (
    <Text dimColor size="caption" weight="medium">
      {title}
      {note !== undefined ? ` · ${note}` : ''}
    </Text>
  )
  const line = (key: string, label: string, tokens: number, mid = false, dot?: string) => (
    <Box key={key} flexDirection="row" alignItems="center" gap={1}>
      {dot !== undefined && Svg !== undefined ? (
        <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="${dot}"/></svg>`} alt="" width={10} height={10} />
      ) : null}
      <Box flexShrink={1} flexGrow={1} minWidth={0}>
        <Text wrap={mid ? 'truncate-middle' : 'truncate-end'}>{label}</Text>
      </Box>
      <Text tabular dimColor>
        {kTokens(tokens)}
      </Text>
    </Box>
  )
  const list = (title: string, rows: readonly CtxRow[], note?: string, mid = false) =>
    rows.length === 0 ? null : (
      <Box key={`sec-${title}`} flexDirection="column" {...card}>
        {head(title, note)}
        {rows.map((r, i) => line(`${title}-${i}`, r.label, r.tokens, mid))}
      </Box>
    )
  // 帯の計測がまだ無いときは内訳（全体 − 空き）から使用量を出す
  const left = untilAuto(c?.autoCompactAt ?? null, u.tokens ?? (c !== null ? c.max - c.free : null))
  const heavyRows = heavy.map(h => ({ label: `${h.tool} ${h.label}`, tokens: Math.round(h.chars / 4) }))
  const heavySum = heavyRows.reduce((n, r) => n + r.tokens, 0)
  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor size="caption" wrap="truncate-end">
            {left !== null ? `自動圧縮まで あと ${kTokens(left)} · ` : c?.autoCompactAt === null ? '自動圧縮はオフ · ' : ''}トークン数は見積もり
          </Text>
        </Box>
        <Button key="cx-refresh" plain dimColor label="更新" onPress={() => void refreshCtx($).then(() => refresh($))} />
      </Box>
      {c === null ? (
        <Text dimColor>内訳を読み込んでいます…</Text>
      ) : (
        <Box key="sec-used" flexDirection="column" rowGap={0} {...card}>
          {head('何が場所を取っているか', `空き ${kTokens(c.free)}`)}
          {Svg !== undefined ? <Svg source={stackSvg(c.used, c.max, c.autoCompactAt)} alt="区分ごとの使用量（縦線は自動圧縮の位置）" width={320} height={14} /> : null}
          {c.used.map((r, i) => line(`used-${i}`, catLabel(r.label), r.tokens, false, catColor(i)))}
        </Box>
      )}
      {list('圧縮すると要約に置き換わるもの', heavyRows, `合計 約${kTokens(heavySum)}`, true)}
      {list(
        '外せるシステムプロンプトのセクション',
        [...sections].sort((a, z) => z.tokens - a.tokens).slice(0, 10).map(x => ({ label: dropped.includes(x.label) ? `${x.label}（外す設定）` : x.label, tokens: x.tokens })),
        '⚙ の「節約」で外せます',
      )}
      {c !== null ? list('メモリファイル', c.memory, 'CLAUDE.md など。中身を短くすると減ります', true) : null}
      {c !== null ? list('MCP サーバー', c.mcp, '使わないサーバーを外すと減ります') : null}
      {c !== null && c.skills > 0 ? list('スキル一覧', [{ label: 'スキルの説明', tokens: c.skills }]) : null}
    </Box>
  )
}

// 設定ペインの「節約」欄（オプトイン。既定はすべてオフ）
async function drawSavings($: EngineInterface, e: Draw) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await read($, savingsA)
  const sections = (await read($, sectionsA)).filter(x => !CORE.has(x.label) && !x.label.includes(':'))
  const card = { backgroundColor: 'rgba(127,127,127,0.08)', paddingX: 1 } as const
  const toggle = (key: string, on: boolean, fn: () => void) => (
    <Button key={key} variant={on ? 'primary' : 'secondary'} label={on ? 'オン' : 'オフ'} onPress={fn} />
  )
  return (
    <Box key="savings" flexDirection="column" rowGap={1}>
      <Text dimColor size="caption" weight="medium">
        節約（コンテキストを減らす · 既定はオフ）
      </Text>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} {...card}>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text weight="semibold">長い出力を先頭と末尾だけ渡す</Text>
          <Text dimColor size="caption" wrap="wrap">
            Bash / PowerShell の出力が {COLLAPSE.max.toLocaleString()} 文字を超えたら、先頭 {COLLAPSE.head.toLocaleString()} と末尾 {COLLAPSE.tail.toLocaleString()} 文字だけを Claude に渡します
          </Text>
        </Box>
        {toggle('sv-collapse', s.collapse, () => void setSavings($, x => ({ ...x, collapse: !x.collapse })))}
      </Box>
      <Box flexDirection="column" rowGap={1} {...card}>
        <Text weight="semibold">使わないシステムプロンプトのセクションを外す</Text>
        <Text dimColor size="caption" wrap="wrap">
          プロンプトキャッシュを壊さないよう、今の会話には効かず、次の新しい会話（または圧縮後）から反映します。本体の指示（intro・system・tools など）は候補に出しません
        </Text>
        {sections.length === 0 ? (
          <Text dimColor size="caption">最初の応答のあとに一覧が出ます</Text>
        ) : (
          sections.map(x => {
            const isDropped = s.dropped.includes(x.label)
            return (
              <Box key={`sv-${x.label}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor={isDropped} wrap="truncate-end">
                    {x.label} · {kTokens(x.tokens)}
                  </Text>
                </Box>
                <Button
                  key={`sv-drop-${x.label}`}
                  variant={isDropped ? 'primary' : 'secondary'}
                  label={isDropped ? '外す' : '残す'}
                  onPress={() =>
                    void setSavings($, v => ({ ...v, dropped: isDropped ? v.dropped.filter(d => d !== x.label) : [...v.dropped, x.label] })).then(() =>
                      $.ui.invalidate('prompt.section'),
                    )
                  }
                />
              </Box>
            )
          })
        )}
      </Box>
    </Box>
  )
}

// ---- register.tsx の同じイベントのフックから呼ぶもの（1つのイベントに matcher なしのフックは1つまでのため） ----

async function usageStart($: EngineInterface) {
  const saved = (await $.store.get('savings')) as Savings | undefined
  if (saved !== undefined && typeof saved.collapse === 'boolean' && Array.isArray(saved.dropped)) await update($, savingsA, () => saved)
  await setUsage($, u => ({ ...u, busy: '' }))
  await refresh($).catch(() => undefined)
}

function usageTurnStart(e: TurnStartInput) {
  if (e.agentId === undefined && e.text !== '') lastPrompt = e.text.replace(/\s+/g, ' ')
}

async function usageTurnComplete($: EngineInterface, e: TurnCompleteInput) {
  if (e.agentId !== undefined) return
  if (e.usage !== undefined) {
    const lastTurn = { ms: e.durationMs, out: e.usage.output_tokens, cacheRate: cacheRate(e.usage) }
    await setUsage($, u => ({ ...u, lastTurn }))
  }
  const tokens = (await read($, usageA)).tokens
  if (tokens !== null) {
    if (turnTokens !== null) {
      const delta = tokens - turnTokens
      await setUsage($, u => ({ ...u, perTurn: nextPerTurn(u.perTurn ?? null, delta) }))
    }
    turnTokens = tokens
  }
  if ((await read($, ctxA)) === null || (await $.ui.panes()).some(p => p.id === CTX_PANE)) void refreshCtx($)
}

// ツール結果：大きいものを覚え、オプトインなら長い Bash / PowerShell 出力を中略する
async function usageAfterTool<R extends ToolCallResult>($: EngineInterface, e: { tool: string; agentId?: string }, ran: R): Promise<R> {
  if (e.agentId !== undefined || ran.deny !== undefined) return ran
  await noteHeavy($, { tool: e.tool, label: labelOf(e as unknown as Record<string, unknown>), chars: (ran.text ?? '').length })
  if ((e.tool !== 'Bash' && e.tool !== 'PowerShell') || ran.isError === true || !(await read($, savingsA)).collapse) return ran
  const res = ran.result as { stdout?: unknown; persistedOutputPath?: unknown } | undefined
  if (typeof res?.stdout !== 'string' || res.persistedOutputPath !== undefined) return ran
  const short = collapse(res.stdout)
  if (short === null) return ran
  return { result: { ...res, stdout: short }, ...(ran.context !== undefined ? { context: ran.context } : {}) } as unknown as R
}

// ---- フック（register.tsx が使っていないイベント） ----

function registerUsage(on: Parameters<Register>[0]) {
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await applyMeasure($, e.context, e.rateLimits)
    return r
  })

  // effort は要求ごとにしか分からないので、メインのループの要求を見て覚える
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? '' : String(e.effort)
      void setUsage($, u => (u.effort === effort && u.model === e.model ? u : { ...u, effort, model: e.model }))
    }
    return yield* next(e)
  })

  // セクションの大きさを覚える（内訳と「節約」の候補に使う）。答えは変えない
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const list = r.sections.map(s => ({ label: s.id, tokens: Math.round(s.text.length / 4) }))
    if (JSON.stringify(list) !== JSON.stringify(await read($, sectionsA))) await update($, sectionsA, () => list)
    return r
  })

  on('prompt.section', async ($, e, next) => ((await read($, savingsA)).dropped.includes(e.name) ? { text: null } : next(e)))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    await update($, heavyA, () => [])
    void refresh($).catch(() => undefined)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: CTX_PANE }, async ($, e) => drawContext($, e))

  // 下部バー（入力欄の下、右側のモード表示）に1行足す：🤖 GPT と 🦀 Claude の 5h / 1w、コンテキストと自動圧縮までの残り。
  // ステータス行（$.ui.status）は mod の名前が付くので使わない。元のモード表示はそのまま前に残す
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const gpt = await read($, gptA)
    const text = footerLine(await read($, usageA), (await read($, ctxA))?.autoCompactAt ?? null, gpt.pair, Math.max(gpt.at, await $.clock.now()))
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, text] } })
  })
}

export const register: Register = on => {
  registerUsage(on)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'codex-ask', description: 'Codex に依頼する（スマホ向け）', argumentHint: '<依頼内容>' })
    await $.command.register({ name: 'codex-image', description: 'Codex に画像を生成させる（スマホ向け）', argumentHint: '<画像の内容>' })
    await $.command.register({ name: 'wb-run', description: '登録スクリプトを実行する（帯で選んでいるもの、または「名前: 入力」）', argumentHint: '[スクリプト名:] [入力]' })
    const started = await next(e)
    void loadCodexLogo($)
    cwd = e.cwd
    sessionId = await $.session.id()
    if (sessionLabel === '') sessionLabel = baseName(cwd)
    const saved = (await $.store.get('layout')) as Layout | undefined
    if (saved?.order !== undefined) await update($, layoutA, () => normalize(saved))
    const savedModel = await $.store.get('model')
    if (typeof savedModel === 'string') await update($, modelA, () => savedModel)
    const hubOn = await $.store.get('hubOn')
    if (typeof hubOn === 'boolean') await update($, hubOnA, () => hubOn)
    const scripts = (await $.store.get('scripts')) as Script[] | undefined
    await update($, scriptsA, () => (Array.isArray(scripts) ? scripts : SEED_SCRIPTS))
    const scriptId = await $.store.get('scriptId')
    const edits = await $.store.get('promptEdits')
    if (edits !== null && typeof edits === 'object') await update($, promptEditsA, () => edits as PromptEdits)
    const order = await $.store.get('promptOrder')
    if (Array.isArray(order)) await update($, promptOrderA, () => order.filter((k): k is string => typeof k === 'string'))
    if (typeof scriptId === 'string') await update($, scriptIdA, () => scriptId)
    await loadCodexConfig($).catch(() => undefined)
    // リロードで子プロセスは止まるので、実行中のまま残った依頼・レビュー・スクリプトは失敗扱いにする
    await update($, jobsA, l => l.map(j => (j.status === 'running' ? { ...j, status: 'failed' as const, endedAt: j.startedAt, result: 'mod の再読み込みで中断しました' } : j)))
    await update($, reviewsA, l => l.map(r => (r.status === 'running' && r.isMod === true ? { ...r, status: 'failed' as const, endedAt: r.startedAt, progress: 'mod の再読み込みで中断しました' } : r)))
    await update($, scriptRunA, r => (r?.status === 'running' ? { ...r, status: 'failed' as const, endedAt: r.startedAt, stderr: 'mod の再読み込みで中断しました' } : r))
    void refreshGit($)
    void refreshGpt($).catch(() => undefined)
    $.clock.every(60_000, () => {
      void refreshGit($)
      void refreshGpt($).catch(() => undefined)
    })
    const hub = await hubDir($)
    await $.fs.write(`${hub}\\pending\\.keep`, '')
    await $.fs.write(`${hub}\\decisions\\.keep`, '')
    // ponytail: 2秒ごとに共有フォルダをポーリング。件数が増えたらファイル監視に置き換える
    $.clock.every(2000, () => {
      void pollHub($)
    })
    if ((await read($, reviewsA)).some(r => r.status === 'running')) ensureTicker($)
    void syncPane($)
    void usageStart($)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '' && sessionLabel === baseName(cwd)) sessionLabel = e.text.replace(/\s+/g, ' ').slice(0, 30)
    usageTurnStart(e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) void refreshGit($)
    await usageTurnComplete($, e)
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    void syncPane($)
    return r
  })

  on('session.detach', async ($, e, next) => {
    const r = await next(e)
    void syncPane($)
    return r
  })

  // Codex レビューの検知（Bash / PowerShell から codex review を実行したとき）。結果は usageAfterTool にも通す
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return usageAfterTool($, e, await next(e))
    const cmd = e.command
    if (!REVIEW.test(cmd)) return usageAfterTool($, e, await next(e))
    const now = await $.clock.now()
    const isBackground = e.run_in_background === true
    const tee = teePath(cmd)
    const job: ReviewJob = {
      id: `r${now}`, ...parseReview(cmd, defaults), startedAt: now, endedAt: null, status: 'running', isBackground,
      ...(tee !== '' ? { logFile: await resolvePath($, tee) } : {}),
    }
    await update($, reviewsA, l => [...l, job].slice(-5))
    await update($, nowA, () => now)
    ensureTicker($)
    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true
    if (!isBackground || failed) await finishReview($, job.id, failed)
    return usageAfterTool($, e, ran)
  })

  // 承認ハブ：人に承認を求める直前（PermissionRequest）だけ共有フォルダに出し、どこかのセッションの応答を待つ。
  // auto モードの自動判定や許可ルールで決まるものはここに来ない。
  on('classic.PermissionRequest', async ($, e, next) => {
    if (PERSON_TOOLS.has(e.tool_name) || (await $.store.get('hubOn')) === false) return next(e)
    const now = await $.clock.now()
    const a: Approval = {
      key: `${e.session_id.slice(0, 8)}_${now}`.replace(/[^\w-]/g, '_'),
      sessionId: e.session_id, label: sessionLabel, cwd: e.cwd, tool: e.tool_name, summary: summarize(e.tool_input),
      createdAt: now, timeoutAt: now + HUB_TIMEOUT_SEC * 1000,
    }
    await $.fs.write(`${await hubDir($)}\\pending\\${a.key}.json`, JSON.stringify(a))
    await pollHub($)
    const answer = await waitDecision($, a).catch(() => 'aborted')
    void pollHub($)
    if (answer === 'allow') return { decision: { behavior: 'allow' } }
    if (answer === 'deny') return { decision: { behavior: 'deny', message: '承認ハブで拒否されました' } }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'codex-ask' }, async ($, e) => {
    await startJob($, 'task', e.args)
    return { text: 'Codex に依頼しました（結果はチャット末尾に出ます）' }
  })
  on('command.run', { command: 'wb-run' }, async ($, e) => {
    const named = /^(.+?):\s*([\s\S]*)$/.exec(e.args)
    const s = (await read($, scriptsA)).find(x => x.name === named?.[1]?.trim())
    const before = await read($, scriptRunA)
    await runScript($, s !== undefined ? { scriptId: s.id, input: named?.[2] ?? '' } : { input: e.args })
    if ((await read($, scriptConfirmA)) !== null) return { text: '書き換え・削除を含むため実行していません。帯の「確認して実行」で実行してください' }
    const r = await read($, scriptRunA)
    if (r === null || r.startedAt === before?.startedAt) return { text: '実行できませんでした（通知を確認してください）' }
    const body = resultText(r)
    return { text: `${r.name}: ${runSummary(r, 0)}\n$ ${r.command}\n\n${body.length > 4000 ? `${body.slice(0, 4000)}\n…（全文は帯の「結果」）` : body}` }
  })
  on('command.run', { command: 'codex-image' }, async ($, e) => {
    await startJob($, 'image', e.args)
    return { text: 'Codex に画像生成を依頼しました（結果はチャット末尾に出ます）' }
  })

  // 帯：自分の分を描き、下に他 mod の分を残す
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await drawWork($, e, false)}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawWork($, e, true))
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => drawWork($, e, true, true))
  on('ui.render', { component: 'Pane', requestId: RESULT }, async ($, e) => drawResult($, e))
  on('ui.render', { component: 'Pane', requestId: DETAIL }, async ($, e) => drawDetail($, e))

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'work-band') return next(e)
    const card = (await read($, cardsA))[e.props.id]
    return card === undefined ? next(e) : drawCard($, e, card)
  })
}
