/**
 * 文件预览不能只靠 z-index 压住 xterm 的 WebGL canvas：WebView 合成层在终端
 * 持续重绘时偶尔会把 canvas 提到预览之上。预览期间直接隐藏终端渲染容器，关闭后
 * 再由调用方刷新终端，避免出现“文件行已选中、右侧仍是终端”的状态。
 */
export function setFilePreviewLayerOpen(preview, terminalBodies, open) {
  preview.classList.toggle('active', open);
  terminalBodies.classList.toggle('preview-obscured', open);
}
