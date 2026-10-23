# Claude Team Sync

Shares what each developer did in Claude Code with the rest of the team, and feeds it back into everyone's Claude sessions.

```
Claude session ends ─► SessionEnd hook records session id ─► .claude/team-sync/pending.jsonl
Click "Team Sync" ─► claude -p summarizes each session (forked, read-only) ─► you review/edit
                  ─► rows appended to a CSV in a git repo and pushed ─► everyone's rows pulled
                  ─► .claude/team-context.md  ◄── imported by CLAUDE.md, so Claude reads it every session
```

The shared file is `team-context.csv` with the columns `Developer Name, Date, Context`.

## One-time: team repo (one person per project)
1. Create an empty git repo for the project (for example `myproject-team-sync`) on GitHub, GitLab or any git host.
2. Give every teammate push access, and make sure their git credentials work (`git clone <url>` in a terminal).

## One-time: each project (one person, then commit)
1. Install the extension.
2. Open the project and run **Team Sync: Set Up This Project**. This:
   - adds `.claude/hooks/record-session.js` and a `SessionEnd` hook in `.claude/settings.json`
   - adds an `@.claude/team-context.md` import and a "check team context before solutioning" instruction to `CLAUDE.md`
   - gitignores `.claude/team-context.md` and `.claude/team-sync/`
3. Click **Team Sync** once and enter the repo URL. It is saved to `.vscode/settings.json` (`teamSync.repoUrl`).
4. Commit `.claude/settings.json`, `.claude/hooks/`, `.vscode/settings.json` and `CLAUDE.md`.

## Each developer
- Work in Claude Code as usual. A session is recorded when it **ends**, and shows up as "N pending".
- Click **Team Sync** in the status bar. Claude writes a handoff for each session, and you review and edit it in the JSON tab, then choose **Push**. Delete an entry from the array to leave it out. **Later** keeps the sessions pending.
- Sessions with nothing worth sharing are skipped automatically (Claude answers "No Info").
- Team context is pulled automatically when VS Code starts. Use **Team Sync: Pull Team Context Only** to refresh.

## How merge conflicts are avoided
Nothing is ever merged. Each sync resets its local clone to the latest remote, re-applies only your new rows, and pushes. If someone pushed first, it repeats (up to 5 times). Rows already in the file are never duplicated.

## Settings
| Setting | Default | |
|---|---|---|
| `teamSync.repoUrl` | | Git URL of the project's team repo |
| `teamSync.branch` | `main` | Branch to sync with |
| `teamSync.file` | `team-context.csv` | CSV path inside the repo |
| `teamSync.authorName` | git `user.name` | Name shown on your handoffs |
| `teamSync.maxEntries` | 50 | Newest handoffs written to the context file (older ones stay in the CSV) |
| `teamSync.autoPullOnStartup` | true | |
| `teamSync.claudePath` | `claude` | Path to the Claude Code CLI |

## Requirements
- Git installed and on your PATH.
- Claude Code CLI installed and logged in.

## Notes
- Handoffs are generated with `claude -p --resume <id> --fork-session --no-session-persistence`, so the original session isn't modified and no extra session is saved. It uses your normal Claude Code login and costs one short request per session.
- Don't put secrets in handoffs: everyone with access to the team repo can read the CSV.

## Development
`npm run compile`, then press **F5** to launch an Extension Development Host.
