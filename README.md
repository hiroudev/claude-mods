# claude-mods

These are mods for Claude Code (the Claude desktop app's Code tab and the CLI). They are function-hook plugins.

| mod | What it does |
|---|---|
| [work-band](work-band) | Gathers work status into one band above the prompt: a Codex request form, the progress of Codex reviews, Codex jobs, the approval hub, a registered-script runner, a Git row, saved prompts and usage (Claude/GPT 5h·1w, context). A settings pane lets you reorder each element and show or hide it. |
| [file-cards](file-cards) | Shows the files Claude created or updated in a turn as a card under the answer. Each row has the file's Windows icon, a New/Updated badge and its full path (shown on hover). Its buttons open the file in its default app (HTML in the default browser), open it in VS Code, open a new workbook from an Excel file (the same as right-click "New"), open it in the Claude pane, open its folder and copy its path. |
## Requirements

- **Windows:** opening files, scripts and the clipboard go through PowerShell.
- **Claude Code:** a version that supports mods (function-hook plugins).
- **Codex CLI:** optional, used by the Codex features of work-band. If the Codex desktop app is installed, its icon is loaded at runtime and shown. This repository does not include the logo image.

## Install

Put the folders anywhere, and add them to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, separated by `;`.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\claude-mods\\work-band;C:\\path\\to\\claude-mods\\file-cards"
  }
}
```

The mods load in sessions started after that.

## Development

The Claude Code CLI writes the engine's type definitions to `.claude-plugin/types/`. They are not included in this repository.

```bash
npx -y -p typescript@5.6.3 tsc -p work-band
claude plugin validate work-band
claude plugin test work-band
```

## Note

The work-band script runner executes commands directly from the mod, without Claude's permission prompt. Only register commands you trust. Commands that look destructive, such as `UPDATE`, `DELETE`, `DROP` or `rm`, run only after you confirm in the band.

## License

[MIT](LICENSE)
