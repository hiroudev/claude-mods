export type ElementId = 'review' | 'icon' | 'model' | 'input' | 'send' | 'image' | 'jobs' | 'approvals' | 'git' | 'script' | 'usage' | 'prompts'

// ---- Claude の利用状況（hooks/usage.tsx） ----

/** 利用枠1つ（five_hour / seven_day など）。hitAt は今のペースで 100% に届く見込みの時刻（リセット前に届かないなら null） */
export type Limit = { kind: string; pct: number; resetsAt: number | null; hitAt: number | null }

export type UsageView = {
  tokens: number | null
  window: number
  pct: number | null
  limits: Limit[]
  model: string
  effort: string
  lastTurn: { ms: number; out: number; cacheRate: number | null } | null
  busy: '' | 'compact' | 'handoff'
  /** 1往復でコンテキストが増えるトークン数の目安（直近を重く見た平均）。まだ分からなければ null */
  perTurn?: number | null
}

/** コンテキストを多く使ったツール結果（chars は結果の文字数） */
export type Heavy = { tool: string; label: string; chars: number }

export type CtxRow = { label: string; tokens: number }

export type CtxView = { used: CtxRow[]; free: number; memory: CtxRow[]; mcp: CtxRow[]; skills: number; autoCompactAt: number | null; max: number }

/** 節約のオプトイン設定（既定はすべてオフ） */
export type Savings = { collapse: boolean; dropped: string[] }

export type Layout = { order: ElementId[]; hidden: ElementId[] }

/** 5h / 1w の利用枠1つ。resetsAt は epoch ms（0 = 不明） */
export type RateWin = { pct: number; resetsAt: number }
export type RatePair = { h5?: RateWin; w1?: RateWin }
/** GPT（Codex）の利用枠。at は読んだ時刻（1分ごとに変わり、下部バーの残り時間を描き直すきっかけ） */
export type GptView = { pair: RatePair; at: number }

/** 保存プロンプトの、設定で変えた見出しと文（キーは PromptKey。変えたものだけ持つ） */
export type PromptEdits = Partial<Record<string, { short?: string; text?: string }>>

export type ReviewJob = {
  id: string
  model: string
  effort: string
  target: string
  prompt: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  isBackground: boolean
  /** Tee-Object の出力先（mod から起動したものは一時ファイル） */
  logFile?: string
  /** 実行中に Codex が最後に出した意味のある1行 */
  progress?: string
  findings?: Finding[]
  /** mod が自分で起動したレビュー（リロードで子プロセスが止まる） */
  isMod?: boolean
}

export type Finding = { severity: string; title: string; location: string; body: string }

export type ScriptIcon = 'terminal' | 'search' | 'git' | 'db'

export type Script = { id: string; name: string; icon: ScriptIcon; template: string; dir: string }

export type ScriptRun = {
  scriptId: string
  name: string
  icon: ScriptIcon
  input: string
  command: string
  dir: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  exitCode: number | null
  output: string
  stderr: string
  delim: ',' | '\t' | ''
  count: number
  isTruncated: boolean
}

export type GitInfo = { branch: string; changes: number; ahead: number; behind: number; hasUpstream: boolean }

export type CodexJob = {
  id: string
  kind: 'task' | 'image'
  model: string
  prompt: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  result: string
  outFile: string
  images: string[]
}

export type Approval = {
  key: string
  sessionId: string
  label: string
  cwd: string
  tool: string
  summary: string
  createdAt: number
  timeoutAt: number
}

export type Card = { kind: 'review'; review: ReviewJob } | { kind: 'job'; job: CodexJob }

declare module 'claude-code' {
  interface PluginState {
    'work-band': {
      cards: Shaped<Record<string, Card>>
      layout: Shaped<Layout>
      isEditing: boolean
      reviews: Shaped<ReviewJob[]>
      jobs: Shaped<CodexJob[]>
      model: string
      draft: string
      models: string[]
      now: number
      approvals: Shaped<Approval[]>
      hubOn: boolean
      scripts: Shaped<Script[]>
      scriptId: string
      scriptArg: string
      scriptRun: Shaped<ScriptRun | null>
      scriptConfirm: Shaped<{ scriptId: string; input: string } | null>
      git: Shaped<GitInfo | null>
      reviewDetail: string
      usage: Shaped<UsageView>
      heavy: Shaped<Heavy[]>
      sections: Shaped<CtxRow[]>
      ctx: Shaped<CtxView | null>
      savings: Shaped<Savings>
      promptEdits: Shaped<PromptEdits>
      promptOrder: string[]
      gpt: Shaped<GptView>
    }
  }
}
