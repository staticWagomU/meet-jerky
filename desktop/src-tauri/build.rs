fn main() {
    #[cfg(target_os = "macos")]
    build_swift_bridges();

    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn build_swift_bridges() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    let swift_dir = manifest_dir.join("swift");
    println!("cargo:rerun-if-changed={}", swift_dir.display());

    // 全 Swift ファイルを 1 本の静的ライブラリにまとめてコンパイルする。
    // (ファイル単位で分けると Swift モジュール解決が面倒になる)
    let swift_sources: Vec<PathBuf> = std::fs::read_dir(&swift_dir)
        .expect("swift/ ディレクトリが見つかりません")
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("swift") {
                println!("cargo:rerun-if-changed={}", path.display());
                Some(path)
            } else {
                None
            }
        })
        .collect();

    if swift_sources.is_empty() {
        return;
    }

    // ターゲットアーキテクチャを target triple から推測
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        Ok(other) => panic!("Unsupported macOS arch: {other}"),
        Err(e) => panic!("CARGO_CFG_TARGET_ARCH not set: {e}"),
    };
    let swift_target = format!("{arch}-apple-macos26.0");

    let lib_name = "meet_jerky_swift";
    let lib_path = out_dir.join(format!("lib{lib_name}.a"));

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
    for src in &swift_sources {
        cmd.arg(src);
    }

    let status = cmd.status().expect("failed to spawn swiftc — is Xcode installed?");
    if !status.success() {
        panic!("swiftc failed with status {status}");
    }

    // 生成した静的ライブラリをリンクする
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static={lib_name}");

    // フレームワーク
    println!("cargo:rustc-link-lib=framework=Speech");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=AppKit");

    // Swift ランタイム (Xcode が /usr/lib/swift に提供)
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
