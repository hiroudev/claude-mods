import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, UiPressArgument } from 'claude-code'

import type { FileItem, FileStatus } from '../types'

const rows = atom({ plugin: 'file-cards', key: 'rows' } as const, {}, { shape: 'rows-1' })
const expanded = atom({ plugin: 'file-cards', key: 'expanded' } as const, {})
const gone = atom({ plugin: 'file-cards', key: 'gone' } as const, {})
// 最終回答の本文（の末尾） → カードの id。カードはその回答の下に付ける
const answers = atom({ plugin: 'file-cards', key: 'answers' } as const, {})
const icons = atom({ plugin: 'file-cards', key: 'iconPx' } as const, {})
export const answerKey = (text: string) => text.replace(/\s+/g, ' ').trim().slice(-300)

const VISIBLE = 3 // これを超える分は「さらに N 件」に畳む
const MAX_FILES = 20
const KEEP_ROWS = 30

// ---------- 種類 ----------

const SKIP_PATH = /[\\/]\.claude[\\/](projects|dev-mods|plugins|todos|shell-snapshots|statsig|skills)[\\/]|[\\/]\.claude-plugin[\\/]|[\\/](node_modules|\.git|\.venv|venv|__pycache__)[\\/]/i
const SKIP_DIR = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'dist', 'build', 'target', '.cache', '.claude', '.idea', '.vscode'])
const TEXTLIKE = new Set(['md', 'txt', 'csv', 'tsv', 'json', 'jsonl', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'cs', 'kt', 'swift', 'c', 'h', 'cpp', 'yml', 'yaml', 'toml', 'xml', 'svg', 'ps1', 'psm1', 'sh', 'bat', 'cmd', 'ini', 'cfg', 'env', 'log', 'sql', 'mmd', 'ipynb'])
// 「開く」で実行されてしまう種類。エディタで開くに置き換える
const RUNNABLE = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'scr', 'lnk', 'reg', 'cpl', 'jar', 'py', 'pyw', 'sh'])

const COLOR: [RegExp, string][] = [
  [/^(xlsx|xlsm|xls|csv|tsv)$/, '#1D6F42'],
  [/^(docx|doc)$/, '#2B579A'],
  [/^(pptx|ppt)$/, '#C43E1C'],
  [/^pdf$/, '#C5221F'],
  [/^(html|htm|css|scss)$/, '#C2410C'],
  [/^(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/, '#6D4FE0'],
  [/^(mp4|mov|webm|mp3|wav|m4a)$/, '#C2255C'],
  [/^(md|txt|log)$/, '#2F6FDB'],
  [/^(ts|tsx)$/, '#3178C6'],
  [/^(js|mjs|cjs|jsx|json|jsonl)$/, '#A16207'],
  [/^(py|ipynb)$/, '#2B6CA3'],
  [/^(zip|7z|tar|gz)$/, '#6B5B3E'],
]
const colorOf = (ext: string) => COLOR.find(([re]) => re.test(ext))?.[1] ?? '#5B6470'
const extLabel = (ext: string) => (ext === '' ? 'FILE' : ext.slice(0, 4).toUpperCase())

// 紙＋折り返し＋色帯の種類アイコン（Svg を描ける画面だけ）
const fileIconSvg = (ext: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40"><path d="M3 1h18l8 8v28a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z" fill="#fff" stroke="#c9c6be"/><path d="M21 1v6a2 2 0 0 0 2 2h6" fill="#efede8" stroke="#c9c6be"/><rect x="1" y="22" width="22" height="11" rx="2" fill="${colorOf(ext)}"/><text x="12" y="30.4" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${extLabel(ext).length > 3 ? 7.5 : 8.5}" font-weight="700" fill="#fff">${extLabel(ext)}</text></svg>`

const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const SVG = 'xmlns="http://www.w3.org/2000/svg"'
// Windows 標準のアイコンフォント（Win11: Segoe Fluent Icons / Win10: Segoe MDL2 Assets）
const ICON_FONT = 'Segoe Fluent Icons, Segoe MDL2 Assets'
const GLYPH = { add: 0xe710, sync: 0xe72c } as const
// 画面の明暗に合わせた色（SVG は外の色を継がないので自前で切り替える）
const DIM_STYLE =
  '<style>.d{fill:#6b6862}.s{stroke:#6b6862}@media (prefers-color-scheme:dark){.d{fill:#b4b1a9}.s{stroke:#b4b1a9}}</style>'
// エクスプローラー風の黄色いフォルダ
// Claude のペインで開く：オレンジの角丸四角に、右のペインを区切る縦線
const PANE_SVG = `<svg ${SVG} viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="#D97757" stroke-width="1.4"/><path d="M10 1.5v13" stroke="#D97757" stroke-width="1.4"/></svg>`
// file: の URL。Markdown のリンク先に置くので、括弧・#・? も符号化する
export const fileUrl = (p: string) =>
  encodeURI(`file:///${p.replace(/\\/g, '/')}`).replace(/[()#?]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const FOLDER_SVG = `<svg ${SVG} viewBox="0 0 16 16"><path d="M1 3.6C1 2.7 1.7 2 2.6 2h3.2c.4 0 .8.2 1.1.5L8.2 4h5.2c.9 0 1.6.7 1.6 1.6v.4H1Z" fill="#E3A21A"/><rect x="1" y="5" width="14" height="9" rx="1.4" fill="#FFC83D"/></svg>`
// コピー（2枚重ねの紙）
const COPY_SVG = `<svg ${SVG} viewBox="0 0 16 16">${DIM_STYLE}<path class="s" d="M5.5 4.5V3c0-.8.7-1.5 1.5-1.5h6c.8 0 1.5.7 1.5 1.5v7c0 .8-.7 1.5-1.5 1.5h-2.5" fill="none" stroke-width="1.3"/><rect class="s" x="1.5" y="4.5" width="9" height="10" rx="1.5" fill="none" stroke-width="1.3"/></svg>`

// 状態バッジ「＋新規」「⟳更新」。ファイルアイコンの下に小さく出す（<title> がツールチップ）
export const statusSvg = (status: 'new' | 'upd') => {
  const [label, tip, bg, glyph] = status === 'new' ? ['新規', '新規作成', '#1F883D', GLYPH.add] : ['更新', '更新', '#9A6700', GLYPH.sync]
  return `<svg ${SVG} viewBox="0 0 34 14"><title>${tip}</title><rect width="34" height="14" rx="7" fill="${bg}"/><text x="8" y="7.4" text-anchor="middle" dominant-baseline="central" font-family="${ICON_FONT}" font-size="7" fill="#fff">&#x${glyph.toString(16)};</text><text x="21.5" y="7.4" text-anchor="middle" dominant-baseline="central" font-family="Yu Gothic UI, Meiryo UI, sans-serif" font-size="9" font-weight="700" fill="#fff">${label}</text></svg>`
}

// ファイル種類：Windows の関連付けアイコン（取れなければ自前の絵）。全文パスのツールチップ付き
const PER_FILE = new Set(['exe', 'lnk', 'ico', 'url', 'cur', 'appref-ms'])
const iconKey = (f: FileItem) => (PER_FILE.has(f.ext) ? keyOf(f.path) : BROWSER_EXT.has(f.ext) ? BROWSER_ICON : `.${f.ext}`)
// 32x32 の画素を、横に同じ色が続く分をまとめた四角形で描く
export const pixelRects = (hex: string) => {
  const px = (x: number, y: number) => hex.slice((y * 32 + x) * 8, (y * 32 + x) * 8 + 8)
  let out = ''
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; ) {
      const c = px(x, y)
      let w = 1
      while (x + w < 32 && px(x + w, y) === c) w++
      const a = parseInt(c.slice(0, 2), 16)
      // 不透明な画素は少し重ねて、拡大縮小で行の間に出る細い隙間を消す
      if (a === 255) out += `<rect x="${x}" y="${y}" width="${w + 0.04}" height="1.04" fill="#${c.slice(2)}"/>`
      else if (a > 0) out += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="#${c.slice(2)}" fill-opacity="${(a / 255).toFixed(2)}"/>`
      x += w
    }
  }
  return out
}
const fileIconSource = (f: FileItem, hex: string | undefined) =>
  hex === undefined
    ? fileIconSvg(f.ext).replace('>', `><title>${xml(f.path)}</title>`)
    : `<svg ${SVG} viewBox="0 0 32 32"><title>${xml(f.path)}</title>${pixelRects(hex)}</svg>`

// パス行：幅に収まるよう中間を「…」で省き、マウスを載せると全文（<title>）
const charW = (c: string) => (c.charCodeAt(0) > 0x2e7f ? 12 : 6.8) // 12px の Segoe UI / Yu Gothic UI のおおよその幅
const textW = (t: string) => [...t].reduce((w, c) => w + charW(c), 0)
export const fitPath = (p: string, max: number) => {
  if (textW(p) <= max) return p
  const cs = [...p]
  const room = max - charW('…')
  let i = 0
  let j = cs.length - 1
  let tail = ''
  let head = ''
  // 末尾（最後のフォルダ名）を多めに残す
  while (j >= 0 && textW(tail) + charW(cs[j] ?? '') <= room * 0.6) tail = (cs[j--] ?? '') + tail
  while (i <= j && textW(head) + textW(tail) + charW(cs[i] ?? '') <= room) head += cs[i++] ?? ''
  return `${head}…${tail}`
}
const PATH_MAX = 340
const pathSvg = (line: string, full: string) => {
  const w = Math.ceil(textW(line)) + 2
  return {
    width: w,
    source: `<svg ${SVG} viewBox="0 0 ${w} 16">${DIM_STYLE}<title>${xml(full)}</title><rect width="${w}" height="16" fill="transparent"/><text class="d" x="0" y="8" dominant-baseline="central" font-family="Segoe UI, Yu Gothic UI, sans-serif" font-size="12">${xml(line)}</text></svg>`,
  }
}

// 見出しのマーク。assets/header-icon.svg か .png を置けばそれを使う
const STAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2.5 13.6 9l6.4 3-6.4 3L12 21.5 10.4 15 4 12l6.4-3Z" fill="#D97757"/></svg>`
let headerIcon: Promise<string> | undefined
const loadHeaderIcon = ($: EngineInterface) =>
  (headerIcon ??= (async () => {
    for (const [file, mime] of [['header-icon.svg', 'image/svg+xml'], ['header-icon.png', 'image/png']] as const) {
      const p = `${$.plugin.root}/assets/${file}`
      if (!(await $.fs.exists(p).catch(() => false))) continue
      const { base64 } = await $.fs.read(p, { as: 'bytes' })
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="data:${mime};base64,${base64}" width="64" height="64" preserveAspectRatio="xMidYMid meet"/></svg>`
    }
    return STAR_SVG
  })())

// ---------- 表記 ----------

export const sizeText = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '')
const keyOf = (p: string) => norm(p).toLowerCase()

// フォルダ（絶対パス）を「縮めてよい頭」と「必ず残す最後のフォルダ名」に分ける
export const dirParts = (dir: string): { head: string; tail: string } => {
  const d = norm(dir)
  const cut = d.lastIndexOf('\\')
  return cut < 0 ? { head: '', tail: `${d}\\` } : { head: d.slice(0, cut + 1), tail: d.slice(cut + 1) }
}

const absolute = (cwd: string, p: string) => norm(/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') ? p : `${cwd}\\${p}`)

// 最終回答の [名前](パス) からローカルパスを拾う（http は除外、:行番号 は外す）
export const linkedPaths = (answer: string): string[] => {
  const out: string[] = []
  for (const m of answer.matchAll(/\[[^\]\n]*\]\(<?([^)\s>]+)>?\)/g)) {
    const href = m[1] ?? ''
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) && !href.startsWith('file:')) continue
    if (href.startsWith('#') || href.startsWith('mailto:')) continue
    let p = href.replace(/^file:\/\/\/?/i, '').replace(/:\d+(-\d+)?$/, '')
    try {
      p = decodeURIComponent(p)
    } catch {}
    out.push(p)
  }
  return out
}

const STATUS_TEXT: Record<FileStatus, string> = { new: '新規', upd: '更新', ref: '' }

// 行を描ける画面が無いとき（デスクトップアプリの Code タブなど）に回答の下へ出す注記（Markdown の表）
const mdPath = (p: string) => `<${p.replace(/\\/g, '/')}>`
const mdText = (t: string) => t.replace(/[|[\]\\`*_]/g, c => `\\${c}`)
export const shortDir = (head: string, tail: string) => {
  const full = `${head}${tail}`
  if (full.length <= 36) return full
  const root = head.split('\\')[0] ?? ''
  return `${root}\\…\\${tail}`
}
export const noteText = (files: readonly FileItem[]) =>
  [
    `**${summary(files)}**`,
    '',
    '| 種類 | ファイル | 状態 | 容量 | フォルダ |',
    '|:-:|:--|:-:|--:|:--|',
    ...files.map(f => {
      const { head, tail } = dirParts(f.dir)
      return `| \`${extLabel(f.ext)}\` | [${mdText(f.name)}](${mdPath(f.path)}) | ${STATUS_TEXT[f.status] || '—'} | ${sizeText(f.size)} | [${mdText(shortDir(head, tail))}](${mdPath(f.dir)}) |`
    }),
  ].join('\n')

export const summary = (files: readonly FileItem[]) => {
  const n = (s: FileStatus) => files.filter(f => f.status === s).length
  return ['成果物', n('new') > 0 ? `新規 ${n('new')}` : '', n('upd') > 0 ? `更新 ${n('upd')}` : '', n('ref') > 0 && n('new') + n('upd') === 0 ? `${n('ref')}件` : '']
    .filter(Boolean)
    .join(' · ')
}

// ---------- 操作（パスはコマンド文字列に埋め込まず環境変数で渡す） ----------

const ps = ($: EngineInterface, script: string, path: string, extra: Record<string, string> = {}) =>
  $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { FC_PATH: path, ...extra },
    timeoutMs: 15_000,
  })

const report = async ($: EngineInterface, ran: Promise<{ exitCode: number; stderr: string }>, ok?: string) => {
  try {
    const r = await ran
    if (r.exitCode !== 0) $.ui.toast(`失敗しました: ${r.stderr.split('\n')[0]?.slice(0, 120) || `終了コード ${r.exitCode}`}`)
    else if (ok !== undefined) $.ui.toast(ok)
  } catch (err) {
    $.ui.toast(`失敗しました: ${String(err).slice(0, 120)}`)
  }
}

const ensure = async ($: EngineInterface, f: FileItem) => {
  if (await $.fs.exists(f.path).catch(() => false)) return true
  await update($, gone, g => ({ ...g, [keyOf(f.path)]: true }))
  $.ui.toast(`見つかりません: ${f.name}（移動または削除済み）`)
  return false
}

const editorExe = async ($: EngineInterface) => {
  const code = `${(await $.env.get('LOCALAPPDATA')) ?? ''}\\Programs\\Microsoft VS Code\\Code.exe`
  return (await $.fs.exists(code).catch(() => false)) ? code : 'notepad.exe'
}

const editFile = async ($: EngineInterface, f: FileItem) => {
  if (!(await ensure($, f))) return
  await report($, ps($, "Start-Process -FilePath $env:FC_EXE -ArgumentList ('\"' + $env:FC_PATH + '\"')", f.path, { FC_EXE: await editorExe($) }))
}

const openFile = async ($: EngineInterface, f: FileItem) => {
  if (RUNNABLE.has(f.ext)) return editFile($, f)
  if (BROWSER_EXT.has(f.ext)) return openInBrowser($, f)
  if (await ensure($, f)) await report($, ps($, 'Start-Process -FilePath $env:FC_PATH', f.path))
}

const openFolder = async ($: EngineInterface, f: FileItem) => {
  if (await $.fs.exists(f.path).catch(() => false)) {
    await report($, ps($, "Start-Process explorer.exe -ArgumentList ('/select,\"' + $env:FC_PATH + '\"')", f.path))
  } else {
    await report($, ps($, 'Start-Process explorer.exe -ArgumentList $env:FC_PATH', f.dir))
  }
}

const copyText = async ($: EngineInterface, text: string, surface: string, done: string) => {
  const copied = await $.ui.copy({ text, surface: surface as never }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) return $.ui.toast(done)
  await report($, ps($, 'Set-Clipboard -Value $env:FC_PATH', text), done)
}

// HTML などは既定のブラウザ（http の関連付け）で開く。取れなければ通常の関連付け
const BROWSER_EXT = new Set(['html', 'htm', 'xhtml', 'svg'])
// $exe に既定ブラウザの exe を入れる（取れなければ $null）
const BROWSER_EXE =
  "$exe = $null; $id = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId; $cmd = if ($id) { (Get-ItemProperty \"Registry::HKEY_CLASSES_ROOT\\$id\\shell\\open\\command\" -ErrorAction SilentlyContinue).'(default)' }; if ($cmd -match '^\"([^\"]+)\"|^(\\S+)') { $exe = if ($Matches[1]) { $Matches[1] } else { $Matches[2] } }"
const BROWSER_PS =
  BROWSER_EXE + "; if ($exe) { Start-Process -FilePath $exe -ArgumentList ('\"' + $env:FC_PATH + '\"') } else { Start-Process -FilePath $env:FC_PATH }"
const openInBrowser = async ($: EngineInterface, f: FileItem) => {
  if (await ensure($, f)) await report($, ps($, BROWSER_PS, f.path))
}

// Excel：右クリックの「新規」と同じ（そのファイルを元に新しいブックを開く）
const EXCEL_EXT = new Set(['xlsx', 'xlsm', 'xls', 'xltx', 'xltm', 'xlt'])
const newFromFile = async ($: EngineInterface, f: FileItem) => {
  if (await ensure($, f)) await report($, ps($, 'Start-Process -FilePath $env:FC_PATH -Verb New', f.path))
}

// Windows の関連付けアイコンを 32x32 の画素（ARGB の16進）で取り出して覚える（拡張子ごとに一度だけ）
// アプリは SVG 内の画像（data: の PNG）を描かないので、画素を四角形で描き直す
// HTML などは「開く」で既定ブラウザが起動するので、アイコンもそのブラウザの exe から取る
const BROWSER_ICON = '@browser'
const ICON_PS =
  'Add-Type -AssemblyName System.Drawing; foreach ($p in $env:FC_PATH -split "`n") { if ($p -eq "' + BROWSER_ICON + '") { ' + BROWSER_EXE + '; if ($exe) { $p = $exe } }; try { $b = [System.Drawing.Icon]::ExtractAssociatedIcon($p).ToBitmap(); $s = New-Object Text.StringBuilder; for ($y = 0; $y -lt 32; $y++) { for ($x = 0; $x -lt 32; $x++) { [void]$s.Append($b.GetPixel($x, $y).ToArgb().ToString("x8")) } }; $s.ToString() } catch { "-" } }'
async function cacheIcons($: EngineInterface, files: readonly FileItem[]) {
  const have = await read($, icons)
  const need = new Map<string, string>()
  for (const f of files) {
    const k = iconKey(f)
    if (have[k] === undefined && !need.has(k)) need.set(k, k === BROWSER_ICON ? BROWSER_ICON : f.path)
  }
  if (need.size === 0) return
  const r = await ps($, ICON_PS, [...need.values()].join('\n')).catch(() => undefined)
  if (r === undefined || r.exitCode !== 0) return
  const out = r.stdout.split(/\r?\n/)
  const keys = [...need.keys()]
  await update($, icons, all => {
    const next = { ...all }
    keys.forEach((k, i) => {
      const b = out[i]?.trim() ?? ''
      if (/^[0-9a-f]{8192}$/.test(b)) next[k] = b
    })
    return next
  })
}

// ---------- ターン内の検出 ----------

type Snap = Map<string, { path: string; mtime: number }> // 小文字パス → 元のパス・更新時刻

// 作業フォルダを浅く見る（Bash / PowerShell で作られたファイル用）
const snapshot = async ($: EngineInterface, root: string): Promise<Snap> => {
  const out: Snap = new Map()
  const walk = async (dir: string, depth: number) => {
    if (out.size >= 3000) return
    const entries = await $.fs.list(dir).catch(() => [])
    for (const e of entries) {
      const p = `${dir}\\${e.name}`
      if (e.kind === 'file') out.set(keyOf(p), { path: p, mtime: e.mtimeMs })
      else if (e.kind === 'dir' && depth < 3 && !SKIP_DIR.has(e.name.toLowerCase())) await walk(p, depth + 1)
    }
  }
  await walk(norm(root), 0)
  return out
}

type Turn = { marks: Map<string, { path: string; status: Exclude<FileStatus, 'ref'> }>; sent: string[]; snap?: Snap; cwd?: string }
const fresh = (): Turn => ({ marks: new Map(), sent: [] })

// ターン内の記録（モジュール変数：リロードで消えてよい一時データ）
let turn = fresh()

function mark(path: string, status: 'new' | 'upd') {
  const k = keyOf(path)
  const prev = turn.marks.get(k)
  turn.marks.set(k, { path: norm(path), status: prev?.status === 'new' ? 'new' : status })
}

// 変更前後の様子を比べて「新規／更新」を記録する。失敗・変化なしは記録しない
async function watchEdit<R extends { deny?: unknown; isError?: boolean }>($: EngineInterface, path: string, run: () => Promise<R>): Promise<R> {
  const before = await $.fs.stat(path).catch(() => undefined)
  const ran = await run()
  const after = await $.fs.stat(path).catch(() => undefined)
  if (ran.deny !== undefined || ran.isError === true) return ran
  if (after?.kind !== 'file') return ran
  if (before === undefined) mark(path, 'new')
  else if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) mark(path, 'upd')
  return ran
}

async function beforeShell($: EngineInterface) {
  if (turn.snap !== undefined) return
  turn.cwd = await $.session.cwd()
  turn.snap = await snapshot($, turn.cwd)
}

export const register: Register = on => {
  on('turn.start', (_$, e, next) => {
    if (e.agentId === undefined) turn = fresh()
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, ($, e, next) => watchEdit($, e.file_path, () => next(e)))
  on('tool.call', { tool: 'Edit' }, ($, e, next) => watchEdit($, e.file_path, () => next(e)))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => watchEdit($, e.notebook_path, () => next(e)))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (await beforeShell($), next(e)))
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => (await beforeShell($), next(e)))

  on('tool.call', { tool: 'SendUserFile' }, async ($, e, next) => {
    const ran = await next(e)
    const cwd = await $.session.cwd()
    if (ran.deny === undefined && ran.isError !== true) turn.sent.push(...e.files.map(p => absolute(cwd, p)))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const t = turn
    turn = fresh()
    const cwd = await $.session.cwd()

    // シェルで変わったファイル：最初のシェル実行前の様子と比べる
    if (t.snap !== undefined && t.cwd !== undefined) {
      for (const [k, now] of await snapshot($, t.cwd)) {
        if (t.marks.has(k)) continue
        const before = t.snap.get(k)
        if (before === undefined || before.mtime !== now.mtime) t.marks.set(k, { path: now.path, status: before === undefined ? 'new' : 'upd' })
      }
    }

    // 並び順：送付・リンクしたもの（主役）→ 新規 → 更新
    const featured = [...t.sent, ...linkedPaths(e.answer).map(p => absolute(cwd, p))]
    const marked = [...t.marks.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === 'new' ? -1 : 1))
    const candidates = [...featured, ...marked.map(m => m.path)]

    const seen = new Set<string>()
    const files: FileItem[] = []
    for (const p of candidates) {
      if (SKIP_PATH.test(p)) continue
      const stat = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
      if (stat?.kind !== 'file') continue
      const real = norm(stat.realPath ?? p)
      if (seen.has(keyOf(real))) continue
      seen.add(keyOf(real))
      const cut = real.lastIndexOf('\\')
      const name = real.slice(cut + 1)
      const dot = name.lastIndexOf('.')
      files.push({
        path: real,
        name,
        dir: real.slice(0, cut),
        ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
        size: stat.size,
        status: t.marks.get(keyOf(p))?.status ?? t.marks.get(keyOf(real))?.status ?? 'ref',
      })
      if (files.length >= MAX_FILES) break
    }

    const ran = await next(e)
    if (files.length === 0) return ran
    await cacheIcons($, files)
    const id = `t${e.turnId}`
    await update($, rows, all => Object.fromEntries([...Object.entries(all).slice(-(KEEP_ROWS - 1)), [id, files]]))
    await update($, answers, all => Object.fromEntries([...Object.entries(all).slice(-(KEEP_ROWS - 1)), [answerKey(e.answer), id]]))
    // 回答の下に描ける画面があればカード（ui.render AssistantMessage）。無ければ（claude -p など）注記
    if ((await $.session.surfaces()).length > 0) return ran
    return { ...ran, text: noteText(files) }
  })

  // 最終回答のブロックの下にカードを付ける。Placed はターミナル専用なのでデスクトップでは使えない
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) return next(e)
    const id = (await read($, answers))[answerKey(e.props.text)]
    if (id === undefined) return next(e)
    const files = (await read($, rows))[id]
    if (files === undefined || files.length === 0) return next(e)
    const isOpen = (await read($, expanded))[id] === true
    const goneMap = await read($, gone)
    const pngs = await read($, icons)
    const icon = await loadHeaderIcon($)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const hasSvg = 'Svg' in ui
    const isTerminal = e.surface === 'terminal'
    const shown = isOpen ? files : files.slice(0, VISIBLE)
    const rest = files.length - shown.length

    // 操作は固定5枠 [開く][Code/新規][ペイン][フォルダ][コピー]。使わない枠は同じ幅で空ける（幅はセル数）
    const slot = (w: number, child?: RenderElement) => (
      <Box width={w} flexShrink={0} justifyContent="center">
        {child ?? <Text> </Text>}
      </Box>
    )

    // アイコンの操作：Windows 標準の記号を描き、その上に透明な Button を重ねて押せるようにする
    // （Button の中には文字しか置けないため）。ターミナルは記号の文字そのまま
    const iconButton = (key: string, svg: string, term: string, name: string, onPress: (p: UiPressArgument) => void) =>
      hasSvg ? (
        <Box position="relative" justifyContent="center" alignItems="center">
          <ui.Svg source={svg} alt={name} width={16} height={16} />
          <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden" justifyContent="center">
            {/* 文字は点字の空白（U+2800）：幅だけあって何も描かれないので、下の絵を隠さない */}
            <Button key={key} plain onPress={onPress}>
              {'⠀⠀⠀'}
            </Button>
          </Box>
        </Box>
      ) : (
        <Button key={key} plain onPress={onPress}>
          {term}
        </Button>
      )

    const fileIcon = (f: FileItem) =>
      hasSvg ? (
        <ui.Svg source={fileIconSource(f, pngs[iconKey(f)])} alt={extLabel(f.ext)} width={34} height={24} isInteractive />
      ) : (
        <Text backgroundColor={colorOf(f.ext)} color="#ffffff" weight="bold">
          {` ${extLabel(f.ext).padEnd(4)} `}
        </Text>
      )

    const row = (f: FileItem, i: number) => {
      const k = keyOf(f.path)
      const isGone = goneMap[k] === true
      const { head, tail } = dirParts(f.dir)
      const meta = `${isGone ? '移動または削除済み' : sizeText(f.size)} · `
      const line = hasSvg ? pathSvg(meta + fitPath(norm(f.dir), PATH_MAX), f.path) : undefined
      return (
        <Box
          key={`r${i}`}
          flexDirection="row"
          alignItems="center"
          gap={1}
          paddingX={1}
          hover={isTerminal ? undefined : { backgroundColor: 'rgba(127,127,127,0.10)' }}
        >
          {/* アイコンの下に状態バッジ。幅はバッジに合わせて固定し、バッジの無い行とも名前をそろえる */}
          <Box flexShrink={0} flexDirection="column" alignItems="center">
            {fileIcon(f)}
            {hasSvg && !isGone && f.status !== 'ref' ? (
              <ui.Svg source={statusSvg(f.status)} alt={STATUS_TEXT[f.status]} width={34} height={14} isInteractive />
            ) : null}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box flexDirection="row" gap={1} minWidth={0}>
              <Box flexShrink={1} minWidth={0}>
                <Text weight="semibold" wrap="truncate-middle" strikethrough={isGone} dimColor={isGone}>
                  {f.name}
                </Text>
              </Box>
              {isGone ? (
                <Box flexShrink={0}>
                  <Text color="error" size="caption">
                    見つかりません
                  </Text>
                </Box>
              ) : f.status !== 'ref' && !hasSvg ? (
                <Box flexShrink={0}>
                  <Text color={f.status === 'new' ? 'success' : 'warning'} size="caption" weight="semibold">
                    {STATUS_TEXT[f.status]}
                  </Text>
                </Box>
              ) : null}
            </Box>
            {line !== undefined ? (
              <Box minWidth={0} overflow="hidden">
                <ui.Svg source={line.source} alt={f.path} width={line.width} height={16} isInteractive />
              </Box>
            ) : (
            <Box flexDirection="row" minWidth={0}>
              <Box flexShrink={0}>
                <Text dimColor size="caption" tabular>
                  {meta}
                </Text>
              </Box>
              {head !== '' ? (
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor size="caption" wrap="truncate-end">
                    {head}
                  </Text>
                </Box>
              ) : null}
              <Box flexShrink={0}>
                <Text dimColor size="caption">
                  {tail}
                </Text>
              </Box>
            </Box>
            )}
          </Box>
          <Box flexDirection="row" flexShrink={0} alignItems="center">
            {slot(
              6,
              isGone ? undefined : (
                <Button key={`${i}:open`} variant={i === 0 ? 'primary' : 'secondary'} onPress={() => void openFile($, f)}>
                  開く
                </Button>
              ),
            )}
            {/* 2つ目の枠：テキスト系は VS Code、Excel は右クリックの「新規」 */}
            {slot(
              7,
              isGone ? undefined : TEXTLIKE.has(f.ext) ? (
                <Button key={`${i}:code`} variant="secondary" onPress={() => void editFile($, f)}>
                  Code
                </Button>
              ) : EXCEL_EXT.has(f.ext) ? (
                <Button key={`${i}:new`} variant="secondary" onPress={() => void newFromFile($, f)}>
                  新規
                </Button>
              ) : undefined,
            )}
            {/* Claude のペインで開く：回答のリンクと同じく file: リンクをアプリに任せる（Button では開けないため Markdown） */}
            {slot(
              4,
              hasSvg && !isGone ? (
                <Box position="relative" justifyContent="center" alignItems="center">
                  <ui.Svg source={PANE_SVG} alt="Claude のペインで開く" width={16} height={16} />
                  <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden" justifyContent="center">
                    <ui.Markdown text={`[⠀⠀⠀](${fileUrl(f.path)})`} />
                  </Box>
                </Box>
              ) : undefined,
            )}
            {slot(4, iconButton(`${i}:folder`, FOLDER_SVG, '📂', 'フォルダを開く', () => void openFolder($, f)))}
            {slot(4, iconButton(`${i}:copy`, COPY_SVG, '⧉', 'パスをコピー', p => void copyText($, f.path, p.surface, `パスをコピーしました: ${f.name}`)))}
          </Box>
        </Box>
      )
    }

    const card = (
      <Box flexDirection="column" borderStyle="round" borderDimColor rowGap={1} paddingY={isTerminal ? 0 : 1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {hasSvg ? <ui.Svg source={icon} alt="" width={16} height={16} /> : <Text color="#D97757">✦</Text>}
            <Text dimColor size="caption" weight="semibold">
              {summary(files)}
            </Text>
          </Box>
          <Button
            key="copy-all"
            plain
            dimColor
            onPress={p => void copyText($, files.map(f => f.path).join('\n'), p.surface, `${files.length}件のパスをコピーしました`)}
          >
            パスをすべてコピー
          </Button>
        </Box>
        {shown.map(row)}
        {files.length > VISIBLE ? (
          <Box paddingX={1}>
            <Button key="more" plain dimColor onPress={() => void update($, expanded, x => ({ ...x, [id]: !isOpen }))}>
              {isOpen ? '▴ 畳む' : `▾ さらに ${rest} 件（${files.slice(VISIBLE).map(f => f.name).join('、').slice(0, 60)}）`}
            </Button>
          </Box>
        ) : null}
      </Box>
    )
    return (
      <Box flexDirection="column" rowGap={1}>
        {await next(e)}
        {card}
      </Box>
    )
  })
}
