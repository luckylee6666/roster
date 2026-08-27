<p align="center">
  <img src="src/assets/logo.png" width="128" height="128" alt="Roster">
</p>

<h1 align="center">Roster</h1>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">中文</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">A desktop command center for multiple AI CLIs, built with Tauri v2.</p>

Latest release: **v1.3.1** — one assistant per conversation with an explicit handoff, each CLI's own permission modes replacing the write toggle, model/effort/mode as one visible control, and rate-limit usage that speaks up before the quota runs out. See the [changelog](CHANGELOG.md) for details.

## Features

- **Two workspaces** — Roster opens in a calm conversation workspace for everyday use; switch to Developer mode at any time for the full terminal, file editing, split panes, and multi-CLI collaboration tools
- **Structured multi-CLI conversations** — the conversation workspace only offers locally installed assistants and can run all eight registered CLIs: **Claude / Grok / Codex / OpenCode / Gemini / agy / Qwen / MiMo Code**. Their recent sessions share one timeline with source badges, preview/delete, same-tool resume, and cross-CLI takeover. History browsing is independent of the smaller handoff context, and saved inline screenshots plus project-local image/video links render in place
- **Project-aware slash commands** — use Roster actions such as `/model`, `/effort` where supported, `/new`, and `/help`, plus skills/custom commands discovered for the current project and current CLI. The backend rediscovers the selection immediately before launch and rejects stale or cross-provider commands
- **Project management** — add, edit, delete projects
- **Run target (optional)** — local machine / server, or leave it unset
- **Server management** — configure SSH servers (host, port, user, password/key login method)
- **Grouping** — group projects, collapsible sidebar, click to locate, rename a group inline (hover → pencil; all projects in it move together)
- **Built-in terminal** — in-app bottom-drawer tabbed terminal managing all sessions; file tree, file preview and editing, color themes, font size, drag-to-insert path; closing a tab asks first and reminds you to let the AI update its memory (see [Using the terminal](#using-the-built-in-terminal))
- **Multi AI CLI launch** — start **Claude / Grok / Codex / opencode / Gemini / agy / Qwen / MiMo Code** in a project directory from the project card, with a tool badge on the tab. Opening a CLI focuses a running tab for that tool, otherwise it resumes the latest on-disk session; a new session starts only when there is no history
- **Project history** — expand a card to search, preview, resume, or delete each CLI's on-disk sessions; running tabs only match an explicit continue/resume
- **Open a set / Collaborate** — one click opens Claude + Codex + Grok in a three-pane main layout; Collaborate lets you choose one installed CLI as the brain and one or more others as workers sharing `.vibe/orchestra/`
- **Unify memory to Claude** (opt-in) — a project `.memory` symlink to Claude's project memory store; off by default, never auto-creates `CLAUDE.md` / `AGENTS.md`
- **Terminal proxy** — optional header switch writes `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` into newly started CLI terminals so a local Clash/Surge port works without TUN
- **Session attention awareness** — when a terminal session goes quiet after a burst of output (an AI CLI likely finished or is waiting for input), you get a desktop notification + chime + an amber pulsing dot on the tab; the session you're actively watching won't interrupt you, and a bell icon in the toolbar toggles it
- **Git status badges** — local project cards show the current branch, working-tree changes (● tracked / + untracked), and ahead/behind vs upstream (↑/↓), or a green ✓ when clean; scanned in the background, refreshed on launch and window focus
- **Session restore** — the terminal remembers your tab layout (dir + CLI per tab) and offers to restore it on next launch; Claude, OpenCode, Grok, Qwen, and MiMo Code use `--continue`, while Codex uses `resume --last` in the saved project directory. Picking a specific Qwen or MiMo Code history row uses `qwen --resume <id>` or `mimo --session <id>`
- **Prompt/snippet library** — keep reusable prompts/commands; manage and inject them in Developer mode or place one into the conversation composer. Insertion never sends automatically, and data stays in `snippets.json`
- **Per-project ideas** — keep multiple rough ideas per project; both workspaces can capture, refine, archive, delete, and place them into the current input without sending automatically
- **Cross-CLI handoff** — from any running registered CLI tab, review that tool's latest project conversation plus the current Git state, edit the handoff draft, then open any other installed CLI to continue without modifying the source session
- **Restore context** — a history icon on each project card opens a one-glance snapshot to resume work: git overview + recent commits + changed files + CLAUDE.md summary + the CLI you last launched there; footer buttons jump back in (open terminal / Claude)
- **Rate-limit usage (no Node)** — usage panel: Claude uses the official `api/oauth/usage` endpoint (5-hour / 7-day, Keychain token; first read prompts authorization); Codex uses the local `codex app-server` `account/rateLimits/read` RPC (ChatGPT plan windows, duration from the server). Cached 60s, near-instant
- **Menu-bar tray** — a macOS menu-bar item shows Claude `5h X% · 7d Y%`, refreshed every 60s; its menu opens the app / refreshes / quits
- **Terminal context %** — Claude tabs show an `NN%` context-window badge (window size read from the startup banner, fill estimated from the transcript; amber ≥70%, red ≥90%); 0 before the first turn of a new session
- **Scan & import** — batch-import git projects from a directory (auto-reads remote, dedups by path)
- **Search** — quickly filter by name, path, description
- **Export** — export project data to Excel
- **Cross-platform** — macOS (Apple Silicon) + Windows (x64 / ARM64)
- **Local storage** — data saved to local JSON files

## Project fields

- Name
- Local path
- Remote repository URL
- Group
- Run target (optional: local / server)
- Server association
- Description

## Using the conversation workspace

The conversation workspace is the default view. It is designed for people who want to work on a project through normal language without managing a terminal.

- Install and sign in to at least one supported CLI. The participant picker only shows locally installed structured adapters for **Claude / Grok / Codex / OpenCode / Gemini / agy / Qwen / MiMo Code**
- Choose a project on the left. The recent timeline combines Claude, Grok, Codex, OpenCode, Gemini, agy, Qwen, and MiMo Code with an explicit source badge. Reopen a row to continue with its CLI, or choose another participant to take over using a filtered natural-language handoff; source IDs are never passed as target resume IDs
- Turns start with the selected CLI's **read-only/plan policy**. Codex uses its `readOnly` sandbox; ordinary Claude and Qwen turns use safe mode; Grok, Gemini, agy, and Qwen request their own sandbox; OpenCode and MiMo Code use their built-in plan agent without enabling dangerous auto-approval flags. Enable **Allow project changes** for one turn when the assistant should edit files or run project commands; the toggle resets afterward. Roster does not auto-grant extra approvals, but third-party plugins, local configuration, and network behavior remain governed by that CLI rather than an OS-level Roster sandbox
- Type `/` in the composer for commands. `/model <id>` works even when a CLI cannot enumerate models; `/effort` appears only for adapters with a mapped effort/variant flag (OpenCode and MiMo Code map it to `--variant`). Project skills and custom commands are discovered per CLI, then rechecked by the backend before execution. A missing, changed, cross-project, or cross-provider command fails closed instead of becoming plain chat. Slash commands cannot run in the same turn as a cross-CLI handoff
- Running an explicitly selected local slash command may require that CLI's safe/customization-disable flag to be relaxed for that one verified command. The existing plan/write policy and sandbox flags remain in force, and Roster still never adds auto-approval or trust-bypass flags
- The center shows the conversation, including validated historical screenshots and project-local image/video links. Long histories use a dedicated bounded transcript instead of the shorter cross-CLI handoff summary. The right rail shows branch/change/commit context, plans, activity, and full current-project idea actions, with folder-open and refresh controls. Existing prompt snippets can be placed into the composer
- Use **Developer mode** when you need the full terminal, file editor, split panes, or collaboration. Switching views preserves the conversation and suspends hidden companion views

## Using the built-in terminal

A bottom-drawer terminal — open it from a project card's terminal icon or the floating button at the bottom-right.

**Workspace modes**
- **Normal**: use the full terminal workspace
- **Relax**: add and manage your own web pages on the right; only HTTPS URLs and HTTP URLs on localhost are allowed. There are no preset sites, so no third-party site loads automatically
- **Entertainment**: choose Tetris or 2048 on the right; Tetris is selected by default the first time, and your last selection is remembered. Click **Terminal** in the right-side bar to return to the Coding area
- Workspace modes and color themes are independent: themes can be switched in any mode, and their backgrounds and character effects apply to the left Coding area

**Launch an AI CLI**
- Each project card shows one-click **Open CLI** buttons for locally installed tools
- If that tool is already running for the project, Roster focuses it. Otherwise it resumes the latest on-disk session; a new session starts only when there is no history. The tab shows a tool badge (claude orange / grok gold / codex blue / opencode green / gemini purple / agy cyan / qwen pink / mimo orange)
- The **+** at the top-left opens a blank terminal (no CLI)
- Prerequisite: the corresponding CLI (`grok` / `codex` / `opencode` / `gemini` / `agy` / `qwen` / `mimo`) must be installed and on your PATH (the terminal uses a login shell, so it will find them)

**File tree + preview** (left)
- The tree is rooted at the active tab's project directory and follows tab switches; folders load lazily on click
- **Single-click a file** → preview on the right; use the pencil in the preview bar to edit code, config, and text (`⌘/Ctrl + S` saves); **double-click** → insert its path into the terminal
- **Drag** a file/folder from the tree onto the terminal → inserts its path (handy for pointing an AI session at a directory)
- Drag the middle splitter to resize the tree; the folder toolbar icon collapses/expands it
- The lower half of the tree is a session rail for the current project: running AI tabs first (click to focus), then recent on-disk sessions (click to resume). Search, preview, and delete stay on the project card. Drag the horizontal splitter to resize; the chevron collapses just the rail

**Project ideas**
- The lightbulb in the terminal toolbar is enabled when the active running tab belongs to a registered project. Each project has its own list, stored locally in `ideas.json`
- Capture as many rough ideas as needed, then edit, archive, or delete them as they evolve. If a project is removed, its remaining ideas can be explicitly reassigned from another project's drawer
- In Developer mode, **Place in current conversation** rechecks the active tab and project, then pastes a single-line draft into that CLI without pressing Enter. The conversation workspace also shows the selected project's active ideas in its right rail; clicking one places it in the composer for review

**Cross-CLI handoff**
- Open any running registered CLI tab in a registered project, then click the two-arrow handoff icon in the terminal toolbar
- Roster reads that CLI's latest project session from disk, keeps the available recent natural-language turns, and adds the current branch and changed-file summary. Tool calls, thinking blocks, and system reminders are excluded where the source format exposes them
- Review or edit the draft, choose any other installed target, and confirm. For example, a Grok session can be handed to Claude. Roster writes an ignored local file under `.vibe/handoff/`, starts a fresh target CLI in the same project, and asks it to inspect that file and the real working tree
- The source tab and all working-tree changes remain untouched. The handoff may be sent to the target CLI provider, so remove anything you do not want to share before confirming

**Supported preview formats**
- **Code / config / text**: syntax highlighting (dozens of languages) and direct editing while preserving UTF-8 BOM, LF/CRLF line endings, permissions, ACLs, extended attributes, and supported platform metadata
- **Images**: png / jpg / gif / webp / svg / ico / avif (checkerboard transparency background)
- **PDF**: inline rendering
- **Markdown**: rendered as a formatted page, with a Source / Rendered toggle (XSS-sanitized, safe to preview from any source)
- **CSV / TSV**: rendered as a table, switchable back to source

The editor supports Tab/Shift+Tab indentation and warns before discarding unsaved changes, closing the window, or quitting from the tray. Saves use an atomic same-directory replacement and perform best-effort conflict checks before replacement; detected changes made by a terminal, Git, or another editor stop the save. An unavoidable extreme concurrent-write race can still exist, so keep important files under version control. Binary, non-UTF-8, read-only, mixed-line-ending, and files over 1 MB remain preview-only.

**Right-click menu** (any file/folder in the tree)
- **Open folder** (folder → open in system file manager; file → open its containing folder)
- **Insert path into terminal** / **Copy path**
- **Move to Trash** (recoverable; asks for confirmation first)

**Color themes**
- Toggle via the palette toolbar icon: **Default Dark** / **Homebrew**, plus the pre-installed editable image themes **Sakura Twilight**, **Neon Rain**, and the Chinese-inspired **Moonlit Brocade**
- Image themes have matching animated pointers, trails, and click particles; resize handles keep their native cursors, and reduced-motion preferences disable decorative motion
- **Moonlit Brocade** uses state-aware Retina 2D layers: while no task is running, the 3584×2240 portrait remains pixel-locked and only source-aligned eyelids, fabric light, jewelry glints, and particles animate. Terminal output fades in the same woman seated at a rosewood desk, typing on a visible keyboard; repeated output keeps that Coding scene alive across short pauses, and a second hands-and-keys frame supplies the local typing loop. No idle video, mesh deformation, or whole-image transform is used, so the face, hands, and brocade cannot be replaced or softened between frames; asset failures or reduced-motion preferences keep the static Retina artwork
- Open **DIY Theme** to choose a built-in or local background, base palette, overlay tint/strength, and click effects; multiple themes can be saved, edited, or deleted

**Escape**
- On macOS, Escape is forwarded into the focused terminal so vim, less, and Claude Code can interrupt. Open dialogs and menus still consume Escape first.

**Font size**
- App chrome and terminal: the **Aa** button in the terminal toolbar. Chrome is **Standard** / **Large** (Large by default); terminal size can be stepped or reset
- Terminal shortcuts: `⌘/Ctrl +` to enlarge, `⌘/Ctrl -` to shrink, `⌘/Ctrl 0` to reset, or `⌘/Ctrl + wheel`

**Drag to insert path**
- Drag a file/folder from Finder / File Explorer onto the terminal panel → its path (quoted if it contains spaces) is written into the active terminal

## Requirements

- Node.js 18+
- pnpm
- Rust 1.70+

## Install dependencies

```bash
pnpm install
```

## Run in development

```bash
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

## Test

```bash
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

For manual layered-character QA, run `python3 -m http.server 4174 --bind 127.0.0.1` from the repository root and open `http://127.0.0.1:4174/tests/terminal-theme-character-fixture.html`. The fixture loads the production controller and assets, exposes character states and a static/dynamic toggle, and supports `?compact=1` for the collapsed-height layout. It is a manual visual harness and is not counted by `pnpm test`.

## Tech stack

- **Frontend**: HTML/CSS/JavaScript (Vanilla)
- **Backend**: Rust + Tauri v2
- **Storage**: JSON files
- **Excel export**: rust_xlsxwriter
- **Built-in terminal**: portable-pty (real PTY, cross-platform; ConPTY/PowerShell on Windows) + xterm.js (vendored)
- **File preview/editing**: highlight.js (highlighting) / marked (Markdown) / DOMPurify (sanitizing), all vendored with no CDN dependency; the Rust backend handles conflict detection and atomic saves

## AI agent instructions

The project root contains `CLAUDE.md`, `AGENTS.md`, and `opencode.json` — these are **local-only** AI instruction files (added to `.gitignore`, not committed to the repository). They configure how Claude Code, Codex, and OpenCode interact with this project.

## Data location

- macOS: `~/.roster/`（隐藏目录，避免清理软件误删）
- Windows: `~\.roster\`
- Linux: `~/.roster/`

  首次启动自动从 `~/.vibe-coding-manage/` 和更早的 Application Support 目录迁移。核心文件：
  - `projects.json` — project data
  - `servers.json` — server config

## Download

Grab the build for your platform from [Releases](https://github.com/luckylee6666/roster/releases):

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Roster_x.y.z_aarch64.dmg` |
| Windows x64 | `..._x64-setup.exe` (installer) or `..._x64_en-US.msi` |
| Windows ARM64 | `..._arm64-setup.exe` (installer) or `..._arm64_en-US.msi` (Surface / Snapdragon ARM devices) |

### macOS install

The published DMG is ad-hoc signed, so the first launch is blocked by macOS:

1. Open the `.dmg` and drag `Roster.app` into Applications
2. The first launch shows "cancelled" / "move to Trash"
3. Open **System Settings → Privacy & Security** and scroll to the bottom
4. Under "Security" you'll see `"Roster" was blocked because it is from an unidentified developer`
5. Click **Open Anyway**, confirm with your password

### Windows install

Unsigned, so SmartScreen will warn on first run:

1. Download the `*-setup.exe` for your architecture and double-click to install
2. If **"Windows protected your PC"** appears, click **More info → Run anyway**
3. Pick x64 or ARM64 to match your CPU architecture
