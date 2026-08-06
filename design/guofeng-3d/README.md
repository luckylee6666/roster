# 黛月华裳人物动效说明

## 当前生产方案

当前生产方案是优先保留美术精度的状态分层人物：

- `design/guofeng-3d/source-frames/` 中 1586×992 的底图和状态图作为未压缩构建源保留，不进入前端资产目录；待机底图生成 3584×2240 `*-retina.png`，其余状态先在同一画布上完成缩放与锐化，再裁成带内置羽化 Alpha 的局部 Retina 贴片。全屏合成时不再由 WebView 临时放大低分图，也不需要为局部动效解码完整画布。
- 待机与休息状态始终使用 `term-bg-guofeng-beauty-retina.png` 作为终端坞的像素锁定底图。人物脸、双手、发饰和衣纹不做整图替换、几何变换或视频插帧，只叠加与原图坐标对齐的眨眼、衣料流光、饰品微光和粒子。
- `term-bg-guofeng-beauty-coding-a-right-patch-retina.png` 在首次收到终端输出时才懒加载，并于执行状态下在右侧羽化淡入，人物清晰坐在书案前使用键盘。
- `term-bg-guofeng-beauty-coding-b-hands-patch-retina.png` 与主 Coding 贴片同时懒加载，只包含双手与键盘的椭圆羽化区域，用于形成敲键循环。
- `term-character-guofeng-beauty-blink-patch-retina.png` 是双眼组合羽化贴片。
- `term-character-guofeng-beauty-smile-patch-retina.png` 是嘴部羽化贴片。
- `src/terminal-theme-character-patch-metadata.js` 记录各贴片在 3584×2240 画布上的精确裁剪坐标；运行时按该坐标定位，不根据元素尺寸重新猜测位置。
- 衣料光泽、饰品微光和花瓣属于独立 CSS 装饰，不改变原图像素。
- 这不是 Live2D Cubism 模型，也不是 3D/VRM；“分层”只描述本项目的 DOM/CSS 局部叠加方案。

[`img2threejs`](https://github.com/img2threejs/img2threejs) 强调的“单图隐藏面不可知、动画部位需要显式层级、视觉结果需要质量门禁”用于本方案的设计取舍；本项目没有复制该仓库的生成代码。

## 本地未跟踪的完整 GLB 实验输出

本机的 `experimental-full-glb/` 可能保留完整拓扑、骨骼、九个面部 morph 和六个状态动画的全 3D 原型，但该目录已被 Git 忽略，不属于仓库制品。用户验收后认为其人物美术质量不达标，因此它已从生产运行路径和安装包中移除；分层素材异常时直接保留原静态主题。需要继续试验时，应运行下方脚本在本机重新生成，不能假定新 clone 的仓库包含这些输出。

契约名称：

- 骨骼：`Head` / `Neck` / `Chest`
- 表情：`blinkLeft` / `blinkRight` / `smile` / `frown`
- 口型：`visemeA` / `visemeI` / `visemeU` / `visemeE` / `visemeO`
- 动画：`idle` / `thinking` / `success` / `error` / `greeting` / `rest`

Blender 5.1 + MPFB 的当前重建命令：

```bash
BLENDER_USER_RESOURCES=/private/tmp/vibe-blender-user \
  /Applications/Blender.app/Contents/MacOS/Blender \
  --background --python-exit-code 1 \
  --python design/guofeng-3d/build_character.py
```

## 生成参考资产

- `turnaround-front-threequarter-profile.png`：同一人物的正面、三分之四与侧面造型参考。
- `expression-viseme-sheet.png`：中性、眨眼、微笑、A/O 口型与皱眉参考。
- `hanfu-brocade-albedo.png`：深青绿与暗金花云纹的无缝汉服锦缎色图。
- `design/guofeng-3d/source-frames/term-character-guofeng-beauty-blink.png`：同一人物、同一画布的自然闭眼构建源；运行时使用双眼组合贴片。
- `design/guofeng-3d/source-frames/term-character-guofeng-beauty-smile.png`：同一人物、同一画布的闭口微笑构建源；运行时使用嘴部贴片。
- `design/guofeng-3d/dance-frames/`：保留已退役的舞蹈实验关键帧与 `sequence.txt`，仅用于离线复盘，不随前端运行包发布。该实验会在帧间改变人物身份、手指和锦缎细节，未通过生产质量门禁。
- `design/guofeng-3d/build_retina_assets.py`：从 `source-frames/` 的 1586×992 构建源一次性生成待机 Retina 底图、四张局部 RGBA 贴片和坐标元数据；使用 Lanczos、CAS 和轻度 Unsharp。脚本需要 FFmpeg 和 Pillow，保留原文件供后续重建。
- `design/guofeng-3d/build_dance_loop.py`：已退役舞蹈实验的离线复现脚本，默认只输出到被 Git 忽略的 `design/guofeng-3d/previews/`，不会写入运行时素材目录。脚本需要在已安装 `rife-mlx`、Pillow、NumPy 且可调用带 `cas` 滤镜的 FFmpeg 环境中执行。
- `design/guofeng-3d/source-frames/term-bg-guofeng-beauty-coding-a.png`：同一人物、同一画布的坐姿书案 Coding 构建源；运行时使用右侧羽化裁剪贴片。
- `design/guofeng-3d/source-frames/term-bg-guofeng-beauty-coding-b.png`：保持主帧构图，只改变手指和键帽亮光的敲键构建源；运行时使用双手和键盘局部贴片。
- `design/guofeng-3d/full-frame-reference/`：迁移前的四张 3584×2240 全画幅动画参考图，仅用于本地视觉回归；目录已加入 `.gitignore`，不会进入 Git 或应用包。

## 第三方资产与许可

- `elvs_50s_updo` 发型：Elvaerwyn，CC BY，来自 [MakeHuman Community Hair02](https://static.makehumancommunity.org/assets/assetpacks/hair02.html) 资产包。
- `mindfront_kimono` 服装：Mindfront (Sweden)，CC0，来自 [MakeHuman Community Dress01](https://static.makehumancommunity.org/assets/assetpacks/dress01.html) 资产包。
- MPFB / MakeHuman 基础人体、皮肤、面部 target 和视素 target 按各自资产包附带的授权条款使用。
- `img2threejs` 方法论参考：Apache-2.0；本仓库只参考设计思路，未复制其源代码。

## 验收

```bash
pnpm test
python3 -m http.server 4174 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4174/tests/terminal-theme-character-fixture.html`，分别检查待机原画、执行中坐姿 Coding、成功、错误和问候状态；追加 `?compact=1` 检查 320px 收起高度。还要确认：

- 待机与休息时人物轮廓、脸、手和衣纹始终与 Retina 原画逐像素一致，DOM 中没有 `<video>`；只有眨眼、衣料流光、饰品微光和粒子等小范围叠层变化。窗口失焦、页面隐藏或终端坞折叠时这些 CSS 动画暂停。
- 首次终端输出会切换到坐姿书案场景，不残留待机局部叠层，同时能看到键盘与局部敲键循环。
- 连续输出只延长当前 Coding 状态，不重复淡入或重启动画。
- 最后一段输出静默 4.2 秒后恢复待机原画；成功、错误或退出事件可立即打断 Coding 状态。
