export type FileItem = { path: string; name: string; dir: string; dirLabel: string; ext: string; size: number }

declare module 'claude-code' {
  interface PluginState {
    'artifact-files': { rows: Shaped<Record<string, FileItem[]>> }
  }
}
