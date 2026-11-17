import type { Limit } from '../types'

// Claude の利用状況の、$ を使わない部分（しきい値・予測・中略・整形）。$ を使う部分は register.tsx の「Claude の利用状況」。
// 古い CLI（2.1.288）は別ファイルへ $ を渡すと読み込まないため、$ を使う関数はすべて register.tsx に置く。
import type { RatePair, RateWin, UsageView } from '../types'

export const CTX_PANE = 'context'
// 帯の INK と同じ色
export const C = { base: '#C9CBD1', off: '#5F636B', warn: '#E0A64A', danger: '#E06C6C' }
export const CTX = { warn: 60, danger: 80 }
export const RATE = { warn: 70, danger: 90 }
export const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }
export const KIND_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '1w', spend_limit: '上限' }
export const COLLAPSE = { max: 8000, head: 3000, tail: 2000 }
// 本体の指示。外すと動作が壊れるので、外す候補に出さない
export const CORE = new Set(['intro', 'system', 'doing_tasks', 'actions', 'tools', 'tone', 'lean_body', 'bare'])

export const EMPTY: UsageView = { tokens: null, window: 0, pct: null, limits: [], model: '', effort: '', lastTurn: null, busy: '' }

// ---- 純粋な関数（テスト対象） ----

export type Level = 'ok' | 'warn' | 'danger'
export const level = (pct: number | null, t: { warn: number; danger: number }): Level =>
  pct === null ? 'ok' : pct >= t.danger ? 'danger' : pct >= t.warn ? 'warn' : 'ok'
export const ctxLevel = (pct: number | null) => level(pct, CTX)
export const rateLevel = (l: Limit, now: number): Level => {
  const lv = level(l.pct, RATE)
  return lv === 'ok' && l.hitAt !== null && l.hitAt - now < 3600_000 ? 'warn' : lv
}

export type Sample = { t: number; pct: number }

// 今のペースで 100% に届く時刻。直近60分の伸び（5分以上の幅があるとき）を優先し、無ければ枠の開始からの平均。
// リセット前に届かない・伸びていないなら null
export const forecast = (o: { pct: number; now: number; resetsAt: number | null; windowMs?: number; samples: readonly Sample[] }): number | null => {
  const { pct, now, resetsAt } = o
  if (pct >= 100) return now
  let rate = 0
  const old = o.samples.find(s => s.t >= now - 3600_000)
  if (old !== undefined && now - old.t >= 300_000 && pct > old.pct) rate = (pct - old.pct) / (now - old.t)
  else if (resetsAt !== null && o.windowMs !== undefined) {
    const elapsed = now - (resetsAt - o.windowMs)
    if (elapsed >= 600_000 && pct > 0) rate = pct / elapsed
  }
  if (rate <= 0) return null
  const hit = now + (100 - pct) / rate
  return resetsAt !== null && hit >= resetsAt ? null : hit
}

// 長い出力を行の切れ目で先頭と末尾だけに。変わらないときは null
export const collapse = (text: string, o = COLLAPSE): string | null => {
  if (text.length <= o.max) return null
  const lines = text.split('\n')
  let i = 0
  let h = 0
  while (i < lines.length && h + (lines[i] as string).length + 1 <= o.head) h += (lines[i++] as string).length + 1
  let j = lines.length
  let t = 0
  while (j > i && t + (lines[j - 1] as string).length + 1 <= o.tail) t += (lines[--j] as string).length + 1
  // 1行が長すぎて行で切れないときは文字で切る
  const head = i === 0 ? text.slice(0, o.head) : lines.slice(0, i).join('\n')
  const tail = j === lines.length ? text.slice(-o.tail) : lines.slice(j).join('\n')
  const cut = text.length - head.length - tail.length
  return `${head}\n… 中略 ${Math.max(0, j - i)}行・${cut}文字（work-band が省略。全文が必要なら対象を絞って再実行してください）…\n${tail}`
}

export const cacheRate = (u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) => {
  const all = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return all === 0 ? null : Math.round((u.cache_read_input_tokens / all) * 100)
}

export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n)

// 「1:20後」「45分後」のような短い残り時間
export const until = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}後` : `${m}分後`
}

export const shortModel = (m: string) => m.replace(/^claude-/, '')

// ---- 内訳ペイン（/context の区分を積み上げの帯で見せる） ----

const CAT_JA: Record<string, string> = {
  'System prompt': 'システムプロンプト',
  'System tools': '組み込みツール',
  'MCP tools': 'MCP ツール',
  'Custom agents': 'エージェント',
  'Memory files': 'メモリファイル',
  Skills: 'スキル',
  Messages: '会話',
  'Autocompact buffer': '自動圧縮の予備',
}
export const catLabel = (name: string) => CAT_JA[name] ?? name

// 区分ごとの色（低彩度の中間トーン。白・暗どちらの背景でも読める）
export const CAT_COLOR = ['#4f7ec9', '#3f9a78', '#b8862e', '#8a6fc0', '#c0695a', '#4a93a6', '#8b8f97', '#a07850']
export const catColor = (i: number) => CAT_COLOR[i % CAT_COLOR.length] as string

/** 区分を左から積んだ横帯。max はウィンドウ全体、autoAt は自動圧縮が走る位置（縦の印） */
export const stackSvg = (rows: readonly { tokens: number }[], max: number, autoAt: number | null, w = 320): string => {
  const h = 10
  const scale = (t: number) => (max > 0 ? Math.min(w, (t / max) * w) : 0)
  let x = 0
  const segs = rows
    .map((r, i) => {
      const sw = scale(r.tokens)
      const s = sw > 0 ? `<rect x="${x.toFixed(1)}" y="2" width="${sw.toFixed(1)}" height="${h}" fill="${catColor(i)}"/>` : ''
      x += sw
      return s
    })
    .join('')
  const mark = autoAt !== null && max > 0 ? `<line x1="${scale(autoAt).toFixed(1)}" y1="0" x2="${scale(autoAt).toFixed(1)}" y2="${h + 4}" stroke="${C.warn}" stroke-width="1.5"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h + 4}"><rect x="0" y="2" width="${w}" height="${h}" rx="2" fill="${C.off}" opacity=".35"/>${segs}${mark}</svg>`
}

/** 自動圧縮まで残りのトークン（自動圧縮がオフ・未計測なら null） */
/** 1往復ぶんの増え方の平均を更新（直近を重く見る）。減った（圧縮した）ときは据え置き */
export const nextPerTurn = (prev: number | null, delta: number) => (delta <= 0 ? prev : prev === null ? delta : Math.round(prev * 0.6 + delta * 0.4))

/** 下部バーのうち Claude のコンテキスト：使用率と自動圧縮までの残り（約何往復か） */
export const footerParts = (u: UsageView, autoAt: number | null): string[] => {
  const left = untilAuto(autoAt, u.tokens)
  const per = u.perTurn ?? null
  return [
    // コンテキストは 📚（積み上がった量）。まだ計測前でも「--%」で出す
    `📚 ${u.pct === null ? '--' : u.pct}%`,
    left === null ? '' : `圧縮まで ${kTokens(left)}${per !== null && per > 0 ? `（約${Math.max(0, Math.floor(left / per))}回）` : ''}`,
  ].filter(Boolean)
}

// ---- 下部バーの 5h / 1w（旧 GPT mod）。GPT は 🤖、Claude は 🦀 で見分ける ----

const pad2 = (n: number) => String(n).padStart(2, '0')
// リセット時刻を過ぎた枠は使用率 0%（次に使った時点で新しい 5h 枠が始まる）
const isReset = (w: RateWin, now: number) => w.resetsAt > 0 && now >= w.resetsAt
const winPct = (w: RateWin | undefined, now: number) => (w === undefined ? '--%' : isReset(w, now) ? '0%' : `${Math.round(w.pct)}%`)
// 5h 枠の残り時間
const winLeft = (w: RateWin | undefined, now: number) => {
  if (w !== undefined && isReset(w, now)) return '5:00'
  if (w === undefined || w.resetsAt <= now) return '-:--'
  const min = Math.ceil((w.resetsAt - now) / 60000)
  return `${Math.floor(min / 60)}:${pad2(min % 60)}`
}
export const ratePart = (p: RatePair, now: number) => `5h ${winPct(p.h5, now)} ${winLeft(p.h5, now)} / 1w ${winPct(p.w1, now)}`

/** Claude の利用枠（session.measure の limits）を 5h / 1w の組に */
export const pairFromLimits = (limits: readonly Limit[]): RatePair => {
  const pick = (kind: string): RateWin | undefined => {
    const l = limits.find(x => x.kind === kind)
    return l === undefined ? undefined : { pct: l.pct, resetsAt: l.resetsAt ?? 0 }
  }
  return { h5: pick('five_hour'), w1: pick('seven_day') }
}

type CodexWindow = { used_percent?: number; window_minutes?: number; resets_at?: number }

/** Codex の rollout ログ（JSONL）の最後の rate_limits 行を読む */
export const fromCodexLog = (text: string): RatePair | undefined => {
  let end = text.length
  while (end > 0) {
    const at = text.lastIndexOf('"rate_limits":{', end)
    if (at < 0) return undefined
    const start = text.lastIndexOf('\n', at) + 1
    const stop = text.indexOf('\n', at)
    end = start - 2
    try {
      const row = JSON.parse(text.slice(start, stop < 0 ? undefined : stop))
      const rl = row?.payload?.rate_limits ?? row?.rate_limits
      const wins: CodexWindow[] = [rl?.primary, rl?.secondary].filter(Boolean)
      if (wins.length === 0) continue
      const pair: RatePair = {}
      for (const w of wins) {
        const win = { pct: w.used_percent ?? 0, resetsAt: (w.resets_at ?? 0) * 1000 }
        if (w.window_minutes === 300) pair.h5 = win
        else if (w.window_minutes === 10080) pair.w1 = win
      }
      return pair
    } catch {
      continue
    }
  }
  return undefined
}

/** 下部バーの1行。名前は付けず、値がまだ無くても「--」で常に出す */
export const footerLine = (u: UsageView, autoAt: number | null, gpt: RatePair, now: number) =>
  [`🤖 ${ratePart(gpt, now)}`, `🦀 ${ratePart(pairFromLimits(u.limits), now)}`, footerParts(u, autoAt).join(' · ')].join('  ')

export const untilAuto = (autoAt: number | null, used: number | null) => (autoAt === null || used === null ? null : Math.max(0, autoAt - used))
