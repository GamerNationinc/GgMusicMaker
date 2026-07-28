// ProfitPals DAW — Tauri shell.
//
// The DAW itself lives in the web frontend (Web Audio API + Canvas). This Rust
// shell just hosts the WebView, wires up the file dialog + filesystem plugins so
// the app can open audio files and save exported mixes, and (on Linux/WebKitGTK)
// makes sure the media backend is enabled so microphone capture works.

pub fn run() {
    // On Linux the WebView is WebKitGTK. Enabling its media stream + WebRTC
    // support is what lets `getUserMedia` (mic/line recording) function. These
    // env vars are read by WebKitGTK at startup; set them before the app builds.
    #[cfg(target_os = "linux")]
    {
        // Enable the media stream / capture pipeline in WebKitGTK.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            // DMABUF renderer can break on some Mesa/Steam Deck driver combos;
            // disabling it is the common fix for a black WebView.
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running ProfitPals DAW");
}
