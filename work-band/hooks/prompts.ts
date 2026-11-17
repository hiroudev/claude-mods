// 保存プロンプト（帯の「保存プロンプト」行）。アイコンは icons.ts の同じキー。
// 押したときの処理は register.tsx（$ を別ファイルに渡せないため）。
// newSession と compact は文を送らず、利用状況行と同じ処理（引き継ぎ・圧縮）を呼ぶ。image は Codex の画像生成。
// text のあるもの（お気に入り含む）は、帯の設定で見出しと文を変えられる（PromptEdits に差分だけ保存）。

import type { PromptEdits } from '../types'

export type PromptKey = 'recommend' | 'japanese' | 'newSession' | 'diagram' | 'handoff' | 'compact' | 'image' | 'fav1' | 'fav2'

export type Prompt = { key: PromptKey; name: string; short: string; mark: string; text?: string }

// short は帯に出す見出し。全部を全角2文字にそろえると、どのボタンも同じ幅になる
export const PROMPTS: Prompt[] = [
  {
    key: 'recommend',
    name: '推奨を返して', short: '推奨',
    mark: '✓',
    text: 'いくつか案がある場合は、あなたが一番よいと思う案を1つ選んで推奨として示し、理由を短く添えてください。比較の羅列ではなく結論から書いてください。',
  },
  { key: 'japanese', name: '日本語で返して', short: '日本', mark: 'あ', text: '以降の返答は日本語でお願いします。' },
  { key: 'newSession', name: '新しいセッションで続ける', short: '新規', mark: '+' },
  { key: 'diagram', name: '図解して', short: '図解', mark: '⌗', text: '今の説明を図解してください。全体の構造や流れが一目で分かる図にし、図の後に要点を短く添えてください。' },
  {
    key: 'handoff',
    name: '引継ぎメモを書いて', short: '引継',
    mark: '→',
    text: '別のセッションや人に引き継げるよう、引継ぎメモを書いてください。目的／終わったこと（変更したファイルのパス）／決めたことと理由／未完了の作業と次の一手／注意点を箇条書きで。',
  },
  { key: 'compact', name: '要約して圧縮', short: '圧縮', mark: '▽' },
  { key: 'image', name: 'Codex で画像を生成', short: '画像', mark: '▣' },
  // お気に入り：初期は空。帯の設定で文を登録する
  { key: 'fav1', name: 'お気に入り 1', short: '定型', mark: '★', text: '' },
  { key: 'fav2', name: 'お気に入り 2', short: '常用', mark: '◆', text: '' },
]

/** 並び順：保存した順に知っているキーを並べ、足りないものは既定の順で後ろに足す */
export const orderKeys = (order: readonly string[]): PromptKey[] => {
  const known: string[] = PROMPTS.map(p => p.key)
  const head = order.filter((k, i): k is PromptKey => known.includes(k) && order.indexOf(k) === i)
  return [...head, ...PROMPTS.map(p => p.key).filter(k => !head.includes(k))]
}

/** key を1つ前（-1）／後ろ（1）へ。端では動かない */
export const moveKey = (order: readonly string[], key: PromptKey, by: -1 | 1): PromptKey[] => {
  const l = orderKeys(order)
  const i = l.indexOf(key)
  const j = i + by
  if (i < 0 || j < 0 || j >= l.length) return l
  const a = l[i] as PromptKey
  l[i] = l[j] as PromptKey
  l[j] = a
  return l
}

/** 設定で変えた見出し・文と並び順を重ねた一覧（見出しを空にしたら元の見出し） */
export const applyEdits = (edits: PromptEdits, order: readonly string[] = []): Prompt[] =>
  orderKeys(order).map(k => {
    const p = PROMPTS.find(x => x.key === k) as Prompt
    const e = edits[p.key]
    return { ...p, short: e?.short?.trim() || p.short, text: p.text === undefined ? undefined : (e?.text ?? p.text) }
  })
