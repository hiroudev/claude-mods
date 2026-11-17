import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileItem } from '../types'

// チャット末尾の行（$.ui.place）だけに出す。帯（AbovePrompt）は使わない。
// 1ターンで Claude が新規作成したファイル（Write）と、最終回答でリンクしたローカルファイルを列挙する。

const rows = atom({ plugin: 'artifact-files', key: 'rows' } as const, {}, { shape: 'rows-2' })

const SKIP = /[\\/]\.claude[\\/](projects|dev-mods|plugins|todos|shell-snapshots|statsig)[\\/]|[\\/]\.claude-plugin[\\/]|[\\/]node_modules[\\/]|[\\/]\.git[\\/]/i
const TEXTLIKE = new Set(['md', 'txt', 'csv', 'tsv', 'json', 'jsonl', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'yml', 'yaml', 'toml', 'xml', 'svg', 'ps1', 'sh', 'bat', 'cmd', 'ini', 'log', 'sql', 'mmd'])

const GLYPH: Record<string, string> = {
  xlsx: '📊', xlsm: '📊', xls: '📊', csv: '📊', tsv: '📊',
  docx: '📝', doc: '📝', md: '📝', txt: '📝',
  pptx: '📽️', ppt: '📽️', pdf: '📕',
  html: '🌐', htm: '🌐',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
  mp4: '🎬', mov: '🎬', webm: '🎬', mp3: '🎵', wav: '🎵', zip: '🗜️',
}
const glyph = (ext: string) => GLYPH[ext] ?? '↗️'

// 種類バッジの色（各アプリの色味に寄せる）
const BADGE: [RegExp, string][] = [
  [/^(xlsx|xlsm|xls|csv|tsv)$/, '#1D6F42'],
  [/^(docx|doc)$/, '#2B579A'],
  [/^(pptx|ppt)$/, '#C43E1C'],
  [/^pdf$/, '#D93025'],
  [/^(html|htm|css)$/, '#E44D26'],
  [/^(png|jpg|jpeg|gif|webp|svg)$/, '#7B61FF'],
  [/^(mp4|mov|webm|mp3|wav)$/, '#D6336C'],
  [/^(md|txt|log)$/, '#3B82F6'],
  [/^(json|jsonl|js|mjs|ts|tsx|jsx|py|ps1|sh|bat|cmd|sql|yml|yaml|toml|xml|ini)$/, '#6E7681'],
]
const badgeColor = (ext: string) => BADGE.find(([re]) => re.test(ext))?.[1] ?? '#5B6470'
const badgeText = (ext: string) => (ext === '' ? 'FILE' : ext.slice(0, 4).toUpperCase())
const badgeSvg = (ext: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 20"><rect width="36" height="20" rx="5" fill="${badgeColor(ext)}"/><text x="18" y="13.6" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9.5" font-weight="700" letter-spacing=".3" fill="#fff">${badgeText(ext)}</text></svg>`

export const sizeText = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

const toItem = (path: string, size: number, home: string): FileItem => {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  const name = path.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  const dir = path.slice(0, cut)
  const dirLabel = home !== '' && dir.toLowerCase().startsWith(home.toLowerCase()) ? `~${dir.slice(home.length)}` : dir
  return { path, name, dir, dirLabel, size, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' }
}

// 最終回答の [名前](パス) を取り出す（http は除外、:行番号 は外す）
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

// 行を置けないときの注記（Markdown）。リンクはアプリのファイル表示で開ける
const mdPath = (p: string) => `<${p.replace(/\\/g, '/')}>`
export const noteText = (files: readonly FileItem[]) =>
  [
    `**成果物 · ${files.length}件**`,
    '',
    ...files.map(f => `- \`${badgeText(f.ext)}\` [${f.name}](${mdPath(f.path)}) — ${sizeText(f.size)} · [${f.dirLabel}](${mdPath(f.dir)})`),
  ].join('\n')

const absolute = (cwd: string, p: string) =>
  (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') ? p : `${cwd}\\${p}`).replace(/\//g, '\\')

const ps = ($: EngineInterface, script: string, path: string, extra: Record<string, string> = {}) =>
  $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { AF_PATH: path, ...extra },
    timeoutMs: 15_000,
  })

const report = async ($: EngineInterface, ran: Promise<{ exitCode: number; stderr: string }>, ok?: string) => {
  try {
    const r = await ran
    if (r.exitCode !== 0) $.ui.toast(`失敗: ${r.stderr.split('\n')[0]?.slice(0, 120) ?? r.exitCode}`)
    else if (ok !== undefined) $.ui.toast(ok)
  } catch (err) {
    $.ui.toast(`失敗: ${String(err).slice(0, 120)}`)
  }
}

const editorExe = async ($: EngineInterface) => {
  const code = `${(await $.env.get('LOCALAPPDATA')) ?? ''}\\Programs\\Microsoft VS Code\\Code.exe`
  return (await $.fs.exists(code)) ? code : 'notepad.exe'
}

const ensure = async ($: EngineInterface, f: FileItem) => {
  if (await $.fs.exists(f.path)) return true
  $.ui.toast(`見つかりません: ${f.name}`)
  return false
}

const openFile = async ($: EngineInterface, f: FileItem) => {
  if (await ensure($, f)) await report($, ps($, 'Start-Process -FilePath $env:AF_PATH', f.path))
}

const editFile = async ($: EngineInterface, f: FileItem) => {
  if (!(await ensure($, f))) return
  const exe = await editorExe($)
  await report($, ps($, "Start-Process -FilePath $env:AF_EXE -ArgumentList ('\"' + $env:AF_PATH + '\"')", f.path, { AF_EXE: exe }))
}

const openFolder = async ($: EngineInterface, f: FileItem) => {
  await report($, ps($, "Start-Process explorer.exe -ArgumentList ('/select,\"' + $env:AF_PATH + '\"')", f.path))
}

const copyPath = async ($: EngineInterface, f: FileItem, surface: string) => {
  const copied = await $.ui.copy({ text: f.path, surface: surface as never }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) return $.ui.toast(`パスをコピーしました: ${f.name}`)
  await report($, ps($, 'Set-Clipboard -Value $env:AF_PATH', f.path), `パスをコピーしました: ${f.name}`)
}

export const register: Register = on => {
  const created = new Set<string>()

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const isNew = !(await $.fs.exists(e.file_path).catch(() => true))
    const ran = await next(e)
    if (isNew && ran.deny === undefined && ran.isError !== true) created.add(e.file_path)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const cwd = await $.session.cwd()
    const candidates = [...created, ...linkedPaths(e.answer).map(p => absolute(cwd, p))]
    created.clear()

    const home = (await $.env.get('USERPROFILE')) ?? ''
    const seen = new Set<string>()
    const files: FileItem[] = []
    for (const p of candidates) {
      if (SKIP.test(p)) continue
      const stat = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
      const real = stat?.realPath ?? p
      if (stat?.kind !== 'file' || seen.has(real.toLowerCase())) continue
      seen.add(real.toLowerCase())
      files.push(toItem(real, stat.size, home))
      if (files.length >= 20) break
    }
    const ran = await next(e)
    if (files.length === 0) return ran
    const id = `f${await $.clock.now()}`
    await update($, rows, all => Object.fromEntries([...Object.entries(all).slice(-29), [id, files]]))
    const placed = await $.ui.place({ id }).catch(() => undefined)
    // デスクトップアプリは末尾の行を描く画面をつながないことがある。そのときは回答の下の注記で出す
    return placed?.isPlaced === true ? ran : { ...ran, text: noteText(files) }
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'artifact-files') return next(e)
    const files = (await read($, rows))[e.props.id]
    if (files === undefined || files.length === 0) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isTerminal = e.surface === 'terminal'
    const badge = (f: FileItem) =>
      'Svg' in ui ? (
        <ui.Svg source={badgeSvg(f.ext)} alt={badgeText(f.ext)} width={36} height={20} />
      ) : (
        <Text backgroundColor={badgeColor(f.ext)} color="#ffffff" weight="bold">
          {` ${badgeText(f.ext).padEnd(4)} `}
        </Text>
      )

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} rowGap={1}>
        <Text dimColor size="caption" weight="medium">
          成果物 · {files.length}件
        </Text>
        {files.map((f, i) => (
          <Box
            key={`row${i}`}
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            gap={1}
            hover={isTerminal ? undefined : { backgroundColor: 'rgba(127,127,127,0.12)' }}
          >
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
              <Box flexShrink={0}>{badge(f)}</Box>
              <Box flexDirection="column" flexShrink={1} minWidth={0}>
                <Text weight="semibold" wrap="truncate-middle">
                  {f.name}
                </Text>
                <Text dimColor size="caption" wrap="truncate-start">
                  {f.dirLabel} · {sizeText(f.size)}
                </Text>
              </Box>
            </Box>
            <Box flexDirection="row" flexShrink={0} gap={1}>
              <Button key={`${i}:open`} plain label={`${f.name} を既定のアプリで開く`} onPress={() => void openFile($, f)}>
                {glyph(f.ext)}
              </Button>
              {TEXTLIKE.has(f.ext) ? (
                <Button key={`${i}:edit`} plain label={`${f.name} をエディタで開く`} onPress={() => void editFile($, f)}>
                  ✏️
                </Button>
              ) : (
                <Text>{'　'}</Text>
              )}
              <Button key={`${i}:folder`} plain label={`${f.name} のフォルダを開く`} onPress={() => void openFolder($, f)}>
                📁
              </Button>
              <Button key={`${i}:copy`} plain label={`${f.name} のパスをコピー`} onPress={p => void copyPath($, f, p.surface)}>
                📋
              </Button>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
