<div align="center">

# urocc

**Control Claude Code from Telegram — multi-session, Chinese-path-friendly.**

</div>

---

`urocc` is a fork of [jsayubi/ccgram](https://github.com/jsayubi/ccgram) with patches focused on multi-project workflows, non-ASCII paths, and tighter session hygiene. All upstream features still work; the changes below are additive or replace clearly broken behavior.

## What's different vs. upstream `ccgram`

| Area | Upstream | urocc |
|---|---|---|
| Path encoding for `getClaudeSessionsForProject` | replaces `/` only — fails on Chinese / underscore paths | replaces every non-`[a-zA-Z0-9.]` char (matches Claude Code) |
| `/resume` (no arg) | lists all projects with history | scopes to the current default workspace |
| `/sessions` & `/<workspace>` routing | shows zombie tmux entries | filters via live `tmux ls` |
| `/clear` | not present | new — prunes dead tmux + dead Ghostty + completed-and-dead |
| `/new` project picker cap | 10 / 20 | 50 |
| Telegram pinned message | none | always shows current default workspace |
| `escapeMarkdown` | escapes `_*\`[` only | also escapes `]()\\` (fixes silent message drops) |
| `qperm` keystroke injection | fixed 4 s `setTimeout` race | polls `tmux capture-pane` for the question UI marker |

See [CHANGELOG.md](CHANGELOG.md) for the upstream version history this fork is based on (v1.2.2).

## Install

The new binary and home dir are renamed (`ccgram` → `urocc`, `~/.ccgram` → `~/.urocc`):

```bash
git clone https://github.com/stefan-song/urocc.git
cd urocc
npm install
npm run build
node dist/setup.js   # interactive wizard
```

The wizard installs to `~/.urocc/`, generates `~/.urocc/.env`, and writes hooks to `~/.claude/settings.json` pointing at `~/.urocc/dist/`.

## Service management

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.urocc

# Linux (systemd template at urocc.service)
sudo systemctl restart urocc

# Logs
tail -f ~/.urocc/logs/bot-stdout.log
tail -f ~/.urocc/logs/bot-stderr.log
```

## Bot commands (forked + new)

| Command | Notes |
|---|---|
| `/sessions` | Live filtering of dead tmux entries |
| `/clear` | **Fork-added** — prune dead/completed sessions |
| `/clear all` | **Fork-added** — wipe entire registry |
| `/use <name>` / `/use clear` | Updates pinned message in the chat |
| `/resume` | Scoped to current default workspace |
| `/resume <project>` | Same as upstream — explicit project lookup |
| `/new <project> [path]` | Picker now lists up to 50 recent projects |
| `/<workspace> <command>` | Routing now verifies live tmux |
| `/status [workspace]` | Same as upstream |
| `/stop [workspace]` | Same as upstream |
| `/effort low\|medium\|high` | Same as upstream |
| `/model sonnet\|opus\|haiku` | Same as upstream |

## Configuration

`~/.urocc/.env` (same fields as upstream `.ccgram/.env`):

```bash
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_CHAT_ID=<your numeric id>
PROJECT_DIRS=/absolute/path/to/projects   # tilde NOT expanded — use absolute
ACTIVE_THRESHOLD_SECONDS=300              # 0 = always notify, 300 = 5min suppression
LOG_LEVEL=info
```

> **Path tip**: the upstream `~` quirk in `PROJECT_DIRS` is preserved — Node's `fs.readdirSync` doesn't expand `~`, so paths in `.env` must be absolute.

## License

MIT — same as upstream. See [LICENSE](LICENSE) for the original copyright (JS Ayubi). Fork additions are MIT under Stefan Song.

---

<div align="center">

Built on top of [jsayubi/ccgram](https://github.com/jsayubi/ccgram). Thanks to the original author.

</div>
