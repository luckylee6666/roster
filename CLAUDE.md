# Vibe Coding Manager 项目记忆

## 项目概览

- 跨平台桌面应用，技术栈为 Tauri v2 + Rust + Vanilla HTML/CSS/JavaScript。
- 前端入口：`src/index.html`、`src/main.js`、`src/styles.css`。
- Rust 后端入口：`src-tauri/src/lib.rs`。
- 当前版本：`v1.2.12`。
- `main` 当前发布提交：`42f97d2`（文件预览编辑与安全保存）。
- Git 提交信息必须使用中文。

## 常用命令

```bash
pnpm install
pnpm tauri dev
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings
```

## 文件预览与编辑

- 终端文件树支持代码、配置、普通文本、Markdown、CSV/TSV 的查看与编辑。
- 前端编辑器状态主要位于 `src/main.js`，纯状态工具位于 `src/file-editor-utils.js`。
- `⌘/Ctrl + S` 保存，支持 Tab/Shift+Tab 缩进。
- 保存请求进行中仍允许继续输入；请求成功只提交发起保存时的快照，期间新增内容继续保留为“未保存”。
- 未保存修改会拦截文件切换、会话切换、窗口关闭、系统退出和托盘退出。
- Markdown 渲染必须继续经过 DOMPurify，不得直接信任文件内 HTML。

## 终端图片主题与 TUI 背景

- 预装图片主题包括樱花暮色、霓虹雨夜和中国风「黛月华裳」。国风运行时背景与菜单图标分别为 `src/assets/term-bg-guofeng-beauty-retina.png`、`src/assets/theme-icon-guofeng-beauty.png`；内置 base 为 `guofeng`，预装主题 ID 为 `guofeng-beauty-default`，一次性种子标记为 `term-guofeng-beauty-seeded`。
- 预装主题种子保存流程集中在 `src/terminal-theme-presets.js`：只有主题表保存成功才写一次性标记；用户删除后不能复活，同 ID 的用户设置不能被默认值覆盖。
- 图片主题通过 `allowTransparency`、透明 xterm 容器和 DOM 渲染器透出背景图；图片主题不得启用 **xterm 自身的 WebGL renderer**，切回纯色主题时再恢复 xterm WebGL。人物动效同样使用独立 DOM/CSS 分层，不创建 Three.js 或 WebGL Canvas。
- 只让 xterm 默认背景透明不够：Codex 等 TUI 会用 ANSI 单元格背景绘制输入框、diff 和审批提示。真彩色背景会写入 span 的 inline style，256 色背景会生成 `xterm-bg-N` class，两类都必须处理。
- 相关逻辑集中在 `src/terminal-theme-utils.js`，由 `src/main.js` 的 `term.onRender` 按动画帧合并重绘范围，并只扫描本次变更行；切换主题时先清理旧覆盖并按新主题做一次全量计算。
- 图片主题下，中性色块（例如 Codex 的 `rgb(28, 28, 28)` 输入框）限制为 18% 不透明度；绿、红、蓝等语义色块限制为 30%，保留 diff/状态含义并让壁纸可见。
- 半透明覆盖只能由 `.terminal-bodies.has-bg` 启用，默认深色、Homebrew 等纯色主题必须保持 TUI 原始背景色。
- 不要直接移除全部 ANSI 背景色，也不要只为某一个 Codex 颜色写死 CSS；后续修改需同时验证 RGB 真彩色和 ANSI 256 色。
- 图片主题的动态鼠标集中在 `src/terminal-theme-pointer.js`，只接受 `sakura`、`neon-rain`、`guofeng` 白名单。只在真实 mouse 移动时隐藏原生光标；手写笔、触屏、终端高度拖动和目录树宽度拖动必须恢复系统光标，并遵循 `prefers-reduced-motion`。
- 「黛月华裳」人物控制器位于 `src/terminal-theme-character.js`，无 DOM 依赖的状态、坐标和 cover 几何位于 `src/terminal-theme-character-utils.js`。待机和休息始终使用完整 Retina 原画 `src/assets/term-bg-guofeng-beauty-retina.png` 作为像素锁定底图，只叠加与原图坐标对齐的 Retina 眨眼、微笑、衣料流光、饰品微光和粒子；不得播放全帧视频，也不得替换脸、手或衣纹。首次进入执行状态时再懒加载 `src/assets/term-bg-guofeng-beauty-coding-a-retina.png` 和 `src/assets/term-bg-guofeng-beauty-coding-b-retina.png`，分别呈现坐姿书案场景与局部双手/键盘敲击。禁止通过 transform、animation 或滤镜移动、缩放、扭曲或重采样整个人物根层和待机底图。
- 分层舞台 `#terminal-character-stage` 是终端坞的直接子元素，DOM 顺序位于 `#terminal-bodies` 前，视觉层级为 `z-index: 0`；终端主体保持 `z-index: 1`。舞台必须 `pointer-events: none`、`aria-hidden` 且不可获得焦点，不能拦截终端输入。
- 只有仍使用内置国风背景的默认/派生主题可启用分层人物；用户选择的任意自定义图片不能叠加该人物。任一表情或坐姿素材加载失败，或 `prefers-reduced-motion` 生效时，必须保留完整 Retina 静态原画，不能显示半套场景。
- 人物状态只由应用事件驱动，不解析或上传终端文本：待机/休息显示像素锁定原画与局部微光，连续输出合并为执行中并切换坐姿键盘场景，在输出静默后回到待机原画；注意提示映射为成功，创建失败映射为错误，退出映射为休息原画。高频输出只能刷新静默计时，不能反复重启场景淡入或打字循环；已退出会话的迟到输出不得重新激活执行动作。右侧人物区域点击可触发问候，但不能阻止或修改终端事件。
- 窗口失焦、页面隐藏或终端坞折叠时，眨眼、键盘敲击帧、装饰 CSS 动画和鼠标微光更新必须暂停；执行状态的静默判断仍按真实输出时间结束，避免恢复窗口后播放过期动作。鼠标只能轻微影响饰品高光，待机人物根层和坐姿场景都必须保持锚定。
- 当前实现是保留原画的 DOM/CSS 分层动效，不是 Live2D Cubism、Three.js 3D、可绕背面的真 3D、VRM 或完整骨骼模型；不得在产品文案中混称。
- 主窗口在“放弃未保存修改并退出”后会调用前端窗口的 `close()`，`src-tauri/capabilities/default.json` 必须保留 `core:window:allow-close`，否则确认退出后窗口无法关闭；不要用只授权 `destroy()` 的 `allow-destroy` 替代。

## 项目表单

- “运行环境”是可选字段；空值代表暂不设置，项目卡片不显示“未知”标签。
- 从“服务器”改为“本地电脑”或“暂不设置”时必须清空旧 `serverId`，相关归一化逻辑位于 `src/project-form-utils.js`。

## 本地调试应用

- `src-tauri/build.rs` 必须追踪 `../src`，避免 Rust 构建复用旧的内嵌前端资源。
- 同一台 Mac 可能同时存在 `/Applications` 的已安装版本、DMG 挂载版本和仓库构建版本。验证当前代码时必须按完整路径启动 `src-tauri/target/debug/bundle/macos/Vibe Coding Manager.app`，不能只按应用显示名选择，否则可能误测旧版本。

## 终端会话恢复

- 应用退出后 PTY 进程不会存活；`term-session-layout` 只保存标签名称、项目目录和启动命令，重开应用后重新创建 PTY。
- CLI 续接命令统一由 `src/session-restore-utils.js` 生成：Claude 与 OpenCode 使用 `--continue`，Codex 使用 `resume --last`。Codex 的 `--last` 默认按当前工作目录选择最近的交互会话，所以创建恢复终端时必须继续使用原标签的 `cwd`。
- 已经包含 Claude/Codex 恢复参数的命令不得重复追加；相关回归测试位于 `tests/session-restore-utils.test.mjs`。
- Rust `terminal_create` 会拒绝不存在、不可访问或并非目录的非空 `cwd`，禁止静默回退到默认目录，避免 Codex 跨项目接错最近会话；空 `cwd` 的普通空白终端仍使用默认目录。
- 前端只有在 `terminal_create` 成功后才把标签标记为可恢复并写入布局；启动失败的红点标签仅用于显示错误，不得再次进入下次恢复列表。

## 后端文件安全边界

- `read_file` / `write_file` 位于 `src-tauri/src/lib.rs`。
- 应用内文本编辑上限为 1MB；读取使用有界文件句柄并额外读取 1 字节检测增长竞争。
- NUL 检测覆盖全部已加载内容，不得只探测文件开头。
- 仅直接编辑 UTF-8 文本；二进制、无效 UTF-8、只读、混合换行和超大文件保持只读预览。
- 保存保留 UTF-8 BOM 以及 LF、CRLF 或 CR 换行风格。
- 保存采用同目录临时文件、落盘同步和原子替换。
- macOS 保留 stat/ACL/扩展属性，Linux/Unix 保留所有者、用户组、权限和扩展属性，Windows 使用 `ReplaceFileW` 保留平台元数据。
- 保存前及替换前会逐字节检查外部修改。该检查是尽力检测，最终原子替换前仍存在无法完全消除的极小并发窗口，文档不得承诺绝对 CAS。

## 测试与验证

- 前端状态测试：`tests/file-editor-utils.test.mjs`。
- 终端背景颜色测试：`tests/terminal-theme-utils.test.mjs`，覆盖中性色、语义色、已有透明度和无效颜色。
- 主题、鼠标、分层人物和表单测试：`tests/terminal-theme-preset.test.mjs`、`tests/terminal-theme-pointer.test.mjs`、`tests/terminal-theme-character.test.mjs`、`tests/project-form.test.mjs`；窗口能力测试为 `tests/app-config.test.mjs`。
- 当前工作区前端测试共 36 项；自动覆盖 RGB 与 ANSI 256 色、重绘行范围、缓存、主题清理、预装主题成功/失败种子语义、动态鼠标输入类型与减少动效、分层人物主题门控/状态映射/互动区域/cover 几何/本地素材与静态降级、运行环境空值归一化、Codex/Claude 重启续接命令及实际恢复编排、失败终端不再持久化、CSS 图片主题门控和窗口关闭权限。
- `tests/terminal-theme-character-fixture.html` 是不计入上述 36 项的人工视觉夹具：在仓库根目录运行 `python3 -m http.server 4174 --bind 127.0.0.1` 后打开对应 URL，可切换人物状态、定格闭眼、切换静态/动态，并追加 `?compact=1` 检查矮终端布局。自动测试不实例化真实浏览器动画，资源就绪、淡入、蒙版边缘、状态反馈和静态降级仍需用该夹具或仓库 Debug App 验收。
- 当前工作区 Rust 测试共 22 项，覆盖终端 cwd 安全边界，以及文件 BOM/换行、外部冲突、后置 NUL、超大文件、无效 UTF-8 和扩展属性保留。
- v1.2.12 发布前结果：前端 2 项测试通过，Rust 20 项测试通过，Clippy 严格模式通过，`git diff --check` 通过。

## 版本与文档

- 版本号必须同步更新：
  - `package.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/Cargo.lock` 中本项目条目
  - `src-tauri/tauri.conf.json`
- 发布说明同步维护：
  - `CHANGELOG.md`
  - `RELEASE_NOTES.md`
  - `README.md`
  - `README.zh-CN.md`
- `v1.2.12` 标签及 `main` 已推送到 `origin`。

## 隐私与忽略规则

- 真实环境配置、API Key、令牌、密码、私钥和本地应用数据不得提交。
- 根 `.gitignore` 已覆盖 `.env*`（保留 example 模板）、私钥/证书容器、Tauri 构建目录和本地 JSON 数据。
- `tests/` 是测试源码，必须纳入版本控制，不应忽略。
- `node_modules/`、`src-tauri/target/`、`src-tauri/gen/`、`.vscode/` 保持忽略。
- 原 `douyin/` 本地素材目录已于 v1.2.12 发布后移到 macOS 废纸篓，不属于项目源码。
