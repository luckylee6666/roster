# Roster

**English** | [中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

A desktop command center for multiple AI CLIs, built with Tauri v2.

Latest release: **v1.2.19** — renamed to **Roster**. See the [changelog](CHANGELOG.md) for details.

## Features

- **Project management** — add, edit, delete projects
- **Run target (optional)** — local machine / server, or leave it unset
- **Server management** — configure SSH servers (host, port, user, password/key login method)
- **Grouping** — group projects, collapsible sidebar, click to locate, rename a group inline (hover → pencil; all projects in it move together)
- **Built-in terminal** — in-app bottom-drawer tabbed terminal managing all sessions; file tree, file preview and editing, color themes, font size, drag-to-insert path; closing a tab asks first and reminds you to let the AI update its memory (see [Using the terminal](#using-the-built-in-terminal))
- **Multi AI CLI launch** — start **Claude / Grok / Codex / opencode / Gemini / agy** in a project directory from the project card, with a tool badge on the tab
- **Project history** — expand a card to search, preview, resume, or delete each CLI's on-disk sessions; running tabs only match an explicit continue/resume
- **Open a set / Collaborate** — one click opens Claude + Codex + Grok in a three-pane main layout; Collaborate assigns one brain and two workers that share `.vibe/orchestra/`
- **Unify memory to Claude** (opt-in) — a project `.memory` symlink to Claude's project memory store; off by default, never auto-creates `CLAUDE.md` / `AGENTS.md`
- **Terminal proxy** — optional header switch writes `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` into newly started CLI terminals so a local Clash/Surge port works without TUN
- **Session attention awareness** — when a terminal session goes quiet after a burst of output (an AI CLI likely finished or is waiting for input), you get a desktop notification + chime + an amber pulsing dot on the tab; the session you're actively watching won't interrupt you, and a bell icon in the toolbar toggles it
- **Git status badges** — local project cards show the current branch, working-tree changes (● tracked / + untracked), and ahead/behind vs upstream (↑/↓), or a green ✓ when clean; scanned in the background, refreshed on launch and window focus
- **Session restore** — the terminal remembers your tab layout (dir + CLI per tab) and offers to restore it on next launch; Claude, OpenCode, and Grok use `--continue`, while Codex uses `resume --last` in the saved project directory
- **Prompt/snippet library** — a toolbar bookmark icon holds reusable prompts/commands; click one to inject it into the current terminal (text only, no auto-Enter, so you can review before sending); add/edit/delete via a management dialog, stored in `snippets.json`
- **Restore context** — a history icon on each project card opens a one-glance snapshot to resume work: git overview + recent commits + changed files + CLAUDE.md summary + the CLI you last launched there; footer buttons jump back in (open terminal / Claude)
- **Rate-limit usage (no dependencies)** — the Claude usage panel shows your real 5-hour / 7-day limit utilization (% + reset countdown), same source as Claude Code's `/usage` (reads the Keychain token and calls the official endpoint; first read prompts a Keychain authorization); cached 60s, near-instant, **no Node required**
- **Menu-bar tray** — a macOS menu-bar item shows `5h X% · 7d Y%`, refreshed every 60s; its menu opens the app / refreshes / quits
- **Terminal context %** — Claude tabs show an `NN%` context-window badge (window size read from the startup banner, fill estimated from the transcript; amber ≥70%, red ≥90%); 0 before the first turn of a new session
- **Cost stats (needs Node)** — Claude cost + Codex/OpenCode weekly usage go through `ccusage` (auto-fetched by `npx`) reading local logs; if Node is missing the section shows a friendly hint with a one-click install link and **does not affect the rate-limit usage above**
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

## Using the built-in terminal

A bottom-drawer terminal — open it from a project card's terminal icon or the floating button at the bottom-right.

**Workspace modes**
- **Normal**: use the full terminal workspace
- **Relax**: add and manage your own web pages on the right; only HTTPS URLs and HTTP URLs on localhost are allowed. There are no preset sites, so no third-party site loads automatically
- **Entertainment**: choose Tetris or 2048 on the right; Tetris is selected by default the first time, and your last selection is remembered. Click **Terminal** in the right-side bar to return to the Coding area
- Workspace modes and color themes are independent: themes can be switched in any mode, and their backgrounds and character effects apply to the left Coding area

**Launch an AI CLI**
- Click the terminal icon on a project card → a menu pops up: **Open Claude / Open Grok / Open Codex / Open opencode / Open Gemini / Open agy**
- A new tab is created, `cd`s into the project directory and runs the command; the tab shows a tool badge (claude orange / grok gold / codex blue / opencode green / gemini purple / agy cyan)
- The **+** at the top-left opens a blank terminal (no CLI)
- Prerequisite: the corresponding CLI (`grok` / `codex` / `opencode` / `gemini` / `agy`) must be installed and on your PATH (the terminal uses a login shell, so it will find them)

**File tree + preview** (left)
- The tree is rooted at the active tab's project directory and follows tab switches; folders load lazily on click
- **Single-click a file** → preview on the right; use the pencil in the preview bar to edit code, config, and text (`⌘/Ctrl + S` saves); **double-click** → insert its path into the terminal
- **Drag** a file/folder from the tree onto the terminal → inserts its path (handy for pointing an AI session at a directory)
- Drag the middle splitter to resize the tree; the folder toolbar icon collapses/expands it

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
