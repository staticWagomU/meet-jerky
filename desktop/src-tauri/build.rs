fn main() {
    #[cfg(target_os = "macos")]
    build_swift_speech_bridge();

    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn build_swift_speech_bridge() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    let swift_src = manifest_dir.join("swift/SpeechAnalyzerBridge.swift");
    println!("cargo:rerun-if-changed={}", swift_src.display());
    println!("cargo:rerun-if-changed=swift");

    // ターゲットアーキテクチャを target triple から推測
    // (CARGO_CFG_TARGET_ARCH = "aarch64" → "arm64" / "x86_64" → "x86_64")
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        Ok(other) => panic!("Unsupported macOS arch: {other}"),
        Err(e) => panic!("CARGO_CFG_TARGET_ARCH not set: {e}"),
    };
    let swift_target = format!("{arch}-apple-macos26.0");

    let lib_name = "speech_bridge";
    let lib_path = out_dir.join(format!("lib{lib_name}.a"));

    // Swift 標準ライブラリのリンク方法は環境差があるため、`-static-stdlib` は
    // 使わず Xcode の Swift ランタイムを動的リンクする前提とする。
    // (flake.nix で /usr/lib/swift を LIBRARY_PATH に追加済み)
    let mut cmd = Command::new("swiftc");
    cmd.args([
        "-emit-library",
        "-static",
        "-parse-as-library",
        "-O",
        "-target",
        &swift_target,
        "-module-name",
        lib_name,
        "-o",
    ]);
    cmd.arg(&lib_path);
    cmd.arg(&swift_src);

    let status = cmd.status().expect("failed to spawn swiftc — is Xcode installed?");
    if !status.success() {
        panic!("swiftc failed with status {status}");
    }

    // 生成した静的ライブラリをリンクする
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static={lib_name}");

    // Swift / Foundation / Speech フレームワーク
    println!("cargo:rustc-link-lib=framework=Speech");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=Foundation");

    // Swift ランタイム (Xcode が /usr/lib/swift に提供)
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
