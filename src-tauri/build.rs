fn main() {
    // Tauri's externalBin convention is `<name>-<target-triple>.<ext>`, so the
    // runtime needs the triple we were compiled for to find the bundled ffmpeg.
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=FLUENT_TARGET_TRIPLE={target}");
    }
    tauri_build::build()
}