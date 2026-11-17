# claude-mods

These are mods for Claude Code (the Claude desktop app's Code tab and the CLI). They are function-hook plugins.

| mod | What it does |
|---|---|
| [work-band](work-band) | Gathers work status into one band above the prompt: a Codex request form, the progress of Codex reviews, Codex jobs, the approval hub, a registered-script runner, a Git row, saved prompts and usage (Claude/GPT 5h·1w, context). A settings pane lets you reorder each element and show or hide it. |
| [artifact-files](artifact-files) | At the end of a turn, lists the files Claude created or linked, with buttons to open them in the default app, open them in an editor, open their folder and copy their path. |

## Requirements

- **Windows:** opening files, scripts and the clipboard go through PowerShell.
- **Claude Code:** a version that supports mods (function-hook plugins).
- **Codex CLI:** optional, used by the Codex features of work-band. If the Codex desktop app is installed, its icon is loaded at runtime and shown. This repository does not include the logo image.

## Install

Put the folders anywhere, and add them to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, separated by `;`.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\claude-mods\\work-band;C:\\path\\to\\claude-mods\\artifact-files"
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
