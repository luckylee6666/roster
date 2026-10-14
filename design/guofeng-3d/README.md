# 黛月华裳分层素材说明

此目录沿用历史名称 `guofeng-3d`，当前只保留生产主题的 Retina 素材构建脚本与说明，不包含运行时 3D 模型。退役的 3D、舞蹈实验脚本及序列清单已移除；本地被 Git 忽略的旧实验产物不在此次清理范围内。

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

## 重建生产素材

应用直接使用已经提交到 `src/assets/` 的生成素材。正常构建和安装不需要重新生成；只有修改主题美术时才需要本地 `source-frames/` 原图、FFmpeg（支持 `cas` 滤镜）与 Pillow。原图已被 Git 忽略，新 clone 不包含它们，须从自己的素材备份恢复，不能用运行时裁剪贴片代替。

```bash
python3 design/guofeng-3d/build_retina_assets.py
```

该命令会覆盖生成的主题素材与坐标元数据，执行后应检查差异并完成下方验收。

- `design/guofeng-3d/source-frames/term-bg-guofeng-beauty.png`：1586×992 待机底图构建源。
- `design/guofeng-3d/source-frames/term-character-guofeng-beauty-blink.png`：同一人物、同一画布的自然闭眼构建源；运行时使用双眼组合贴片。
- `design/guofeng-3d/source-frames/term-character-guofeng-beauty-smile.png`：同一人物、同一画布的闭口微笑构建源；运行时使用嘴部贴片。
- `design/guofeng-3d/build_retina_assets.py`：从 `source-frames/` 的 1586×992 构建源一次性生成待机 Retina 底图、四张局部 RGBA 贴片和坐标元数据；使用 Lanczos、CAS 和轻度 Unsharp。脚本需要 FFmpeg 和 Pillow，保留原文件供后续重建。
- `design/guofeng-3d/source-frames/term-bg-guofeng-beauty-coding-a.png`：同一人物、同一画布的坐姿书案 Coding 构建源；运行时使用右侧羽化裁剪贴片。
- `design/guofeng-3d/source-frames/term-bg-guofeng-beauty-coding-b.png`：保持主帧构图，只改变手指和键帽亮光的敲键构建源；运行时使用双手和键盘局部贴片。
- `design/guofeng-3d/full-frame-reference/`：迁移前的四张 3584×2240 全画幅动画参考图，仅用于本地视觉回归；目录已加入 `.gitignore`，不会进入 Git 或应用包。

## 第三方资产与许可

以下 MakeHuman/MPFB 署名仅为本地可能保留的退役 3D 实验资产留档，不表示它们仍进入生产主题或安装包：

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
