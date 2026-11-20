// new: このターンで作成 / upd: このターンで更新 / ref: 回答でリンク・送付しただけ（変更なし）
export type FileStatus = 'new' | 'upd' | 'ref'
export type FileItem = { path: string; name: string; dir: string; ext: string; size: number; status: FileStatus }

declare module 'claude-code' {
  interface PluginState {
    'file-cards': {
      rows: Shaped<Record<string, FileItem[]>>
      expanded: Record<string, boolean>
      gone: Record<string, boolean>
      answers: Record<string, string>
      // 拡張子（.exe などはパス）→ Windows の関連付けアイコン（32x32 の ARGB を16進で並べたもの）
      iconPx: Record<string, string>
    }
  }
}
