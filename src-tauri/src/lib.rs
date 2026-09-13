// GgMusicMaker — Tauri shell.
//
// The DAW itself lives in the web frontend (Web Audio API + Canvas). This Rust
// shell hosts the WebView, wires up the file dialog + filesystem plugins so the
// app can open audio files and save exported mixes, and on Linux/WebKitGTK
// grants the microphone permission that recording depends on.

#[cfg(target_os = "linux")]
use tauri::Manager;

pub fn run() {
    // On Linux the WebView is WebKitGTK. The DMABUF renderer breaks on some
    // Mesa / Steam Deck driver combinations, showing a black window; disabling
    // it is the standard fix. Set before any window is created.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // WebKitGTK denies getUserMedia unless the permission-request signal is
    // handled, which would silently break recording in the packaged app. Allow
    // media requests explicitly; everything else keeps the default (deny).
    #[cfg(target_os = "linux")]
    let builder = builder.setup(|app| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.with_webview(|webview| {
                // `Cast` provides `downcast`; the *Ext traits provide allow/deny
                // and connect_permission_request.
                use webkit2gtk::glib::Cast;
                use webkit2gtk::{
                    PermissionRequestExt, UserMediaPermissionRequest, WebViewExt,
                };
                let wv = webview.inner();
                wv.connect_permission_request(|_, req| {
                    // Only auto-grant microphone/camera capture, which the user
                    // has already opted into by pressing Record.
                    if req.clone().downcast::<UserMediaPermissionRequest>().is_ok() {
                        req.allow();
                    } else {
                        req.deny();
                    }
                    true
                });
            });
        }
        Ok(())
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running GgMusicMaker");
}
