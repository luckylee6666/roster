# Design System: Vibe Coding Manager

## 1. Visual Theme & Atmosphere

Vibe Coding Manager is a dense, desktop-first developer workspace modeled after a calm professional IDE. The interface is dark, compact, and operational: hierarchy comes from tonal layers, one-pixel dividers, restrained blue focus indicators, and monospace terminal content rather than decorative cards or large shadows. New terminal split-screen controls must feel native to the existing tab bar and terminal dock, not like a separate dashboard.

The workspace supports one, two, or four visible terminal panes while preserving an unlimited background session list. A pane is a view slot, not ownership of a session. The active pane must be unmistakable without visually overpowering neighboring terminals.

## 2. Color Palette & Roles

- **Dock Charcoal (#1B1F27):** Main terminal dock and active tab surface.
- **Terminal Ink (#14171E):** Terminal pane and file-preview canvas.
- **Raised Slate (#232936):** Toolbars, pane headers, menus, and elevated controls.
- **Lower Slate (#1D222C):** Secondary toolbar gradients and inactive pane headers.
- **Structural Rule (#2B313D):** One-pixel borders, splitters, and section dividers.
- **Primary Focus Blue (#1677FF):** Active pane outline, selected layout action, and keyboard focus.
- **Hover Blue (#4096FF):** Hover and high-visibility focus feedback.
- **Primary Text (#E6EAF2):** Active labels and high-priority UI text.
- **Muted Text (#AEB6C4):** Inactive tabs, helper labels, and toolbar icons.
- **Dim Text (#7F8998):** Metadata and secondary status text.
- **Running Green (#52C41A):** Live-session state only.
- **Attention Amber (#FAAD14):** Waiting or attention-required state.
- **Failure Red (#FF4D4F):** Failed sessions and destructive actions.

## 3. Typography Rules

- Interface text uses the operating-system sans-serif stack, prioritizing PingFang SC on macOS and Microsoft YaHei on Windows.
- Terminal content, code, paths, and numeric pane markers use JetBrains Mono with Menlo, Monaco, Courier New, and monospace fallbacks.
- Dense control labels use 11 to 13px sizes with medium weight. Avoid oversized headings inside the terminal dock.
- Pane titles remain single-line with ellipsis; status badges never displace the project name completely.

## 4. Component Stylings

* **Tool Buttons:** Compact 28px square icon buttons with gently rounded 6px corners. Hover uses a subtle light overlay; selected layout controls use a translucent focus-blue fill.
* **Tabs:** Full-height compact rows with squared structural edges. Active state uses a thin blue top indicator and darker surface, while visible split sessions also receive a small numbered pane badge.
* **Terminal Panes:** Flat containers separated by one-pixel structural rules. The focused pane uses an inset blue outline and a raised pane header; inactive panes remain low contrast.
* **Pane Headers:** Compact utility bars containing pane number, project/session name, tool badge, branch, and a remove-from-layout icon. Removing a pane never terminates its session.
* **Splitters:** Thin draggable dividers with an enlarged invisible hit target. Hover and drag states use focus blue without shadows.
* **Empty Pane:** A restrained centered placeholder with a session selector action; no illustration or oversized empty-state card.
* **Menus:** Raised Slate surfaces with 8px corners, one-pixel borders, and compact rows. Layout choices show single, two-column, two-row, and four-grid diagrams.

## 5. Layout Principles

- Preserve the current single-pane layout as the default and fallback.
- Support a maximum of four visible pane slots in a two-by-two grid. Additional sessions remain alive in the top tab strip.
- Selecting a visible session focuses its existing pane. Selecting a hidden session replaces only the focused pane's view; the displaced session continues running in the background.
- New sessions fill the first empty pane. When all visible slots are occupied, a new session replaces the focused pane's view.
- Closing a pane removes only that view slot. Closing a tab remains the only action that terminates a session.
- The file tree, file preview, input routing, theme character state, and toolbar actions follow the focused pane.
- Horizontal and vertical splitters are draggable. Every visible xterm instance must be refitted after layout, dock-size, tree-width, or window-size changes.
- When the dock is too short for four readable terminals, preserve the grid but communicate the constrained state; never silently close or pause sessions.
