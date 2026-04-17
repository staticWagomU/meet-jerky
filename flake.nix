{
  description = "meet-jerky — Chrome拡張 + Tauri 2 デスクトップアプリの開発環境";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Rustツールチェインの管理に rust-overlay を使用
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    rust-overlay,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        # rust-overlay をオーバーレイとして適用
        overlays = [(import rust-overlay)];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # macOS (darwin) かどうかの判定
        isDarwin = pkgs.stdenv.isDarwin;

        # ─────────────────────────────────────────────
        # Rust ツールチェイン（最新 stable）
        # ─────────────────────────────────────────────
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "rust-src" # rust-analyzer が必要とするソース
            "rust-analyzer" # IDE サポート
            "clippy" # リンター
            "rustfmt" # フォーマッター
          ];
        };

        # ─────────────────────────────────────────────
        # macOS 固有の依存関係
        #
        # 新しい nixpkgs では個別のフレームワークパッケージ
        # (darwin.apple_sdk.frameworks.*) は廃止され、
        # apple-sdk_NN パッケージが統合 SDK を提供する。
        #
        # ScreenCaptureKit は macOS 13+ / SDK 15 が必要なので
        # apple-sdk_15 を使用する。
        #
        # 含まれるフレームワーク:
        #   Tauri 2 必須: Security, AppKit, WebKit,
        #                 CoreFoundation, CoreGraphics
        #   音声キャプチャ用: CoreAudio, AudioToolbox,
        #                    ScreenCaptureKit, AVFoundation
        # ─────────────────────────────────────────────
        darwinPackages = with pkgs; [
          apple-sdk_15 # macOS SDK 15（全フレームワークを含む）
          libiconv # 文字エンコーディング変換（macOS ビルドで必要）
        ];

        # ─────────────────────────────────────────────
        # 全プラットフォーム共通パッケージ
        # ─────────────────────────────────────────────
        commonPackages = with pkgs; [
          # Rust ツールチェイン
          rustToolchain

          # Node.js（Chrome 拡張 + Tauri フロントエンドで使用）
          nodejs_22
          # npm は nodejs_22 に含まれている

          # ビルドツール
          pkg-config # ネイティブ依存関係の検出
          cmake # whisper-rs-sys のビルドに必要
          clang # whisper-rs の bindgen に必要
          llvmPackages.libclang # bindgen のバックエンド
        ];
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = commonPackages ++ pkgs.lib.optionals isDarwin darwinPackages;

          # ─────────────────────────────────────────────
          # 環境変数の設定
          # ─────────────────────────────────────────────
          shellHook = ''
            # bindgen が clang のヘッダーを見つけられるようにする
            export LIBCLANG_PATH="${pkgs.llvmPackages.libclang.lib}/lib"

            # macOS 向け bindgen 追加フラグ（SDK の sysroot を指定）
            ${pkgs.lib.optionalString isDarwin ''
              export BINDGEN_EXTRA_CLANG_ARGS="-isysroot ${pkgs.apple-sdk_15.sdkroot}"

              # screencapturekit クレートの Swift ブリッジビルドには
              # Xcode の Swift ツールチェインと一致する SDK が必要。
              # nix は DEVELOPER_DIR と SDKROOT を apple-sdk_15 に設定するが、
              # これは Swift 6.1.2 でビルドされており Xcode の Swift 6.2 と
              # 互換性がないため、Xcode のパスに上書きする。
              if [ -d "/Applications/Xcode.app/Contents/Developer" ]; then
                export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
                export SDKROOT="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
                # Swift ランタイムライブラリへのリンクパスを追加
                # screencapturekit クレートの Swift ブリッジが Swift の
                # Dispatch, Foundation 等のシンボルを必要とする
                export NIX_LDFLAGS="$NIX_LDFLAGS -L/usr/lib/swift"
                export LIBRARY_PATH="/usr/lib/swift:''${LIBRARY_PATH:-}"
              fi
            ''}

            echo "──────────────────────────────────────"
            echo "meet-jerky 開発環境が準備できました"
            echo ""
            echo "  Rust:    $(rustc --version)"
            echo "  Cargo:   $(cargo --version)"
            echo "  Node.js: $(node --version)"
            echo "  npm:     $(npm --version)"
            echo "──────────────────────────────────────"
          '';
        };
      }
    );
}
