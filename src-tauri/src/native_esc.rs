//! macOS WKWebView 会把 ESC 当成 `cancelOperation:` 在原生层吞掉，DOM 收不到。
//! 这里装一个进程内 NSEvent 本地监听，把裸 ESC 转成 `native-esc` 事件给前端。
//! 不吞掉原事件：弹窗/菜单在非输入框焦点下仍走原来的 DOM `keydown`。

use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub fn install_native_esc_monitor(app: AppHandle) {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use tauri::Emitter;

    const ESC_KEY_CODE: u16 = 53;
    let intercept = NSEventModifierFlags::Command
        | NSEventModifierFlags::Control
        | NSEventModifierFlags::Option;

    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit 在回调期间保证 NSEvent 指针有效。
        let native_event = unsafe { event.as_ref() };
        if native_event.keyCode() == ESC_KEY_CODE
            && !native_event.modifierFlags().intersects(intercept)
        {
            let _ = app.emit("native-esc", ());
        }
        event.as_ptr()
    });

    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
    };

    // AppKit 持有 monitor；block 必须活过整个进程生命周期。
    std::mem::forget(handler);
    std::mem::forget(monitor);
}

#[cfg(not(target_os = "macos"))]
pub fn install_native_esc_monitor(_app: AppHandle) {}
