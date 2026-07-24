# Vibe Coding Manager

[English](README.md) | **中文** · [更新日志](CHANGELOG.md)

一个用于管理 Vibe Coding 项目的桌面应用，基于 Tauri v2 构建。

## 功能特性

- **项目管理** — 添加、编辑、删除项目
- **运行环境** — 本地电脑 / 服务器
- **服务器管理** — 配置 SSH 服务器（IP、端口、用户名、密码/秘钥登录方式）
- **分组管理** — 项目分组，侧边栏展开/折叠，点击定位，分组就地重命名（hover → 铅笔，组内项目一起迁移）
- **内置终端** — 应用内底部抽屉多标签终端，集中管理所有会话；支持文件树导览、文件预览、配色主题、字号调整、拖拽插路径；关标签前先确认并提醒让 AI 更新记忆（详见下方[内置终端使用](#内置终端使用)）
- **多 AI CLI 启动** — 项目卡片一键在项目目录启动 **Claude / Codex / opencode / Gemini / agy**，标签上有工具色标区分
- **会话状态感知** — 终端会话「持续输出后突然安静」即判定 AI 跑完 / 在等你输入，弹桌面通知 + 提示音 + 标签琥珀呼吸点；正盯着看的会话不打扰，工具栏铃铛可开关
- **Git 状态徽标** — 本地项目卡片显示当前分支、工作区改动（● 已追踪 / + 未追踪）、相对上游领先/落后（↑/↓），干净则绿色 ✓；后台并行扫描，启动 + 窗口聚焦时刷新
- **会话恢复** — 记住上次终端标签布局（目录 + CLI），重开应用询问是否恢复；Claude 标签用 `--continue` 接上次对话
- **Prompt 片段库** — 终端工具栏书签图标，存常用 Prompt/命令，点一条注入当前终端（仅文本、不自动回车，可先检查再发送）；管理弹窗增删改，存于 `snippets.json`
- **恢复现场** — 项目卡片历史图标，一张速览接回上次工作：git 概览 + 最近提交 + 改动文件 + CLAUDE.md 摘要 + 上次启动的 CLI；底部一键打开终端 / Claude
- **限流用量（零依赖）** — Claude 用量面板顶部显示真实 5 小时 / 7 天限流使用率（百分比 + 重置倒计时），和 Claude Code 的 `/usage` 同源（读钥匙串 token 调官方接口，首次弹钥匙串授权）；缓存 60 秒、秒出，**无需 Node**
- **菜单栏托盘** — macOS 菜单栏常驻显示 `5h X% · 周 Y%`，每 60 秒刷新；菜单可打开应用 / 刷新 / 退出
- **终端上下文 %** — Claude 会话标签显示 `NN%` 上下文占用（读启动横幅判窗口大小 + transcript 估算，≥70% 橙、≥90% 红），新会话发话前为 0
- **花费统计（需 Node）** — Claude 花费 + Codex/OpenCode 周用量经 `ccusage`（随 `npx` 自动下载）读本地日志；没装 Node 时该区友好提示并一键跳转安装，**不影响上面的限流用量**
- **扫描导入** — 扫描目录批量导入 git 项目（自动读取 remote、按路径去重）
- **搜索过滤** — 快速搜索项目名称、路径、描述
- **数据导出** — 导出项目数据为 Excel 文件
- **跨平台** — macOS (Apple Silicon) + Windows (x64 / ARM64)
- **本地存储** — 数据自动保存到本地 JSON 文件

## 项目信息字段

- 项目名称
- 本地路径
- 远端仓库地址
- 项目分组
- 运行环境（本地电脑 / 服务器）
- 服务器关联
- 项目描述

## 内置终端使用

底部抽屉式终端，点项目卡片的终端图标或右下角悬浮按钮打开。

**启动 AI CLI**
- 点项目卡片上的终端图标 → 弹出菜单，选 **打开 Claude / 打开 Codex / 打开 opencode / 打开 Gemini / 打开 agy**
- 自动新建标签、`cd` 到项目目录并运行对应命令；标签上显示工具色标（claude 橙 / codex 蓝 / opencode 绿 / gemini 紫 / agy 青）
- 面板左上「＋」开一个空白终端（不跑任何 CLI）
- 前提：对应 CLI（`codex` / `opencode` / `gemini` / `agy`）需已安装并在 PATH 中（终端走登录 shell，能找到）

**文件树 + 预览**（左侧）
- 树根为当前标签所在项目目录，切换标签自动跟随；点文件夹懒加载展开
- **单击文件** → 右侧预览；**双击文件** → 把路径插入当前终端
- **拖动**树里的文件/文件夹到终端 → 插入路径（跟 AI 对话指定目录很方便）
- 拖动中间分隔条调整树宽；点工具栏文件夹图标可收起/展开文件树

**预览支持的格式**
- **代码 / 配置 / 文本**：语法高亮（几十种语言）
- **图片**：png / jpg / gif / webp / svg / ico / avif（棋盘格透明底）
- **PDF**：内嵌渲染
- **Markdown**：渲染成排版页面，预览栏「源码 / 渲染」按钮可切换（已做 XSS 净化，任意来源都可安全预览）
- **CSV / TSV**：渲染成表格，可切回源码

**右键菜单**（树里任意文件/文件夹）
- **打开文件夹**（文件夹 → 在系统文件管理器打开；文件 → 打开所在文件夹）
- **插入路径到终端** / **复制路径**
- **移到废纸篓**（进系统回收站，可恢复；删除前有确认）

**配色主题**
- 点工具栏调色板图标切换：**默认深色** / **Homebrew**，以及预装且可编辑的图片主题 **樱花暮色** / **霓虹雨夜**
- 打开 **DIY 自定义主题** 可选择内置或本地背景、基础配色、遮罩色/浓度和点击特效，并保存、编辑或删除多套主题

**字号调整**
- `⌘/Ctrl +` 放大、`⌘/Ctrl -` 缩小、`⌘/Ctrl 0` 复位，或 `⌘/Ctrl + 滚轮`

**拖拽插路径**
- 从 Finder / 资源管理器拖文件或文件夹到终端面板 → 自动把路径（含空格会加引号）写入当前终端

## 开发环境要求

- Node.js 18+
- pnpm
- Rust 1.70+

## 安装依赖

```bash
pnpm install
```

## 开发运行

```bash
pnpm tauri dev
```

## 构建打包

```bash
pnpm tauri build
```

## 技术栈

- **前端**: HTML/CSS/JavaScript (Vanilla)
- **后端**: Rust + Tauri v2
- **数据存储**: JSON 文件
- **Excel 导出**: rust_xlsxwriter
- **内置终端**: portable-pty (真实 PTY，跨平台；Windows 走 ConPTY/PowerShell) + xterm.js (vendor)
- **文件预览**: highlight.js（高亮）/ marked（Markdown）/ DOMPurify（净化），均 vendor，无 CDN 依赖

## 数据存储位置

- macOS: `~/Library/Application Support/vibe-coding-manage/`
  - `projects.json` — 项目数据
  - `servers.json` — 服务器配置
- Windows: `%APPDATA%/vibe-coding-manage/`
- Linux: `~/.local/share/vibe-coding-manage/`

## 下载

前往 [Releases](https://github.com/luckylee6666/vibe-coding-manage/releases) 下载对应平台版本：

| 平台 | 文件 |
| --- | --- |
| macOS (Apple Silicon) | `VibeCodingManager_x.y.z_aarch64.dmg` |
| Windows x64 | `..._x64-setup.exe`（安装版）或 `..._x64_en-US.msi` |
| Windows ARM64 | `..._arm64-setup.exe`（安装版）或 `..._arm64_en-US.msi`（Surface / 骁龙等 ARM 设备）|

### macOS 安装说明

由于应用未签名，首次打开会被 macOS 拦截，请按以下步骤授权：

1. 双击 `.dmg` 文件，将 `Vibe Coding Manager.app` 拖入 Applications
2. 首次打开时会提示“已取消”或“移到废纸篓”
3. 打开 **系统设置 → 隐私与安全性**，滚动到底部
4. 在“安全性”区域会看到 `“Vibe Coding Manager”已被阻止打开，因为它来自未验证的开发者`
5. 点击 **仍要打开**，输入密码确认即可

### Windows 安装说明

应用未签名，首次运行会弹出 SmartScreen 提示：

1. 下载对应架构的 `*-setup.exe` 双击安装
2. 若弹出 **“Windows 已保护你的电脑”**，点 **更多信息 → 仍要运行**
3. 按 x64 / ARM64 选择对应自己 CPU 架构的安装包
