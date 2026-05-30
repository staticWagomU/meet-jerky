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
        # swift ツールチェイン shim（macOS）
        #
        # 問題: このビルドは2つのツールチェインが SDK を奪い合う。
        #   - Nix の cc/clang/ld ラッパー（ring・whisper の C、rustc の最終リンク）は
        #     SDKROOT/DEVELOPER_DIR が「Nix値か未設定」でないと壊れる（純粋性のため
        #     非 /nix の sysroot を無視し、フレームワーク・libSystem・SDK ヘッダーを
        #     見失う）。
        #   - swift（screencapturekit の SwiftPM・自前ブリッジ）は system swiftc
        #     (6.3.x) を使い、Nix の apple-sdk_15 (Swift 6.1.2) では SwiftShims 不一致
        #     で壊れる。system SDK (CLT/Xcode) が必須。
        # この2つは同一ビルドで env を共有するため、1組の SDKROOT/DEVELOPER_DIR では
        # 両立できない。
        #
        # 解決策: global env は Nix 既定のまま（SDKROOT=Nix）にして Nix 側を満たし、
        # swift / swiftc / xcrun だけ PATH に shim を前置して system SDK へ向ける。
        # screencapturekit は `swift`/`xcrun` を PATH 経由で呼ぶため shim で捕捉でき、
        # SwiftPM が spawn する swiftc も shim が export した SDKROOT を継承する。
        # ─────────────────────────────────────────────
        systemDevDir = ''
          if [ -d /Applications/Xcode.app/Contents/Developer ]; then
            DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
          else
            DEVELOPER_DIR=/Library/Developer/CommandLineTools
          fi
          export DEVELOPER_DIR
        '';
        mkSwiftShim = tool:
          pkgs.writeShellScriptBin tool ''
            ${systemDevDir}
            export SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path 2>/dev/null)"
            exec "$DEVELOPER_DIR/usr/bin/${tool}" "$@"
          '';
        xcrunShim = pkgs.writeShellScriptBin "xcrun" ''
          ${systemDevDir}
          unset SDKROOT
          exec /usr/bin/xcrun "$@"
        '';
        swiftToolchainShims = [
          (mkSwiftShim "swift")
          (mkSwiftShim "swiftc")
          xcrunShim
        ];

        # ─────────────────────────────────────────────
        # rustc 最終リンク専用ラッパー（macOS）
        #
        # このバイナリは自前ブリッジ + screencapturekit の Swift を多用し、
        # macOS 26 の Speech/AVFoundation/ScreenCaptureKit 等を参照する。
        # Nix の ld は Swift の auto-link（.o の LC_LINKER_OPTION）を解決できず、
        # 検索パスと .tbd を与えても swiftCore/overlay/framework がリンクされず
        # 大量の未定義シンボルになる。
        #
        # 解決策: 最終リンクだけ Apple の system cc(ld64) を SDKROOT=CLT で使う。
        # macOS 26 SDK の framework・swift overlay・libSystem が一貫解決される。
        # コンパイルは Nix のまま（global SDKROOT=Nix）で、Nix の rlib は system
        # libSystem と ABI 互換なので問題なくリンクできる。
        # ─────────────────────────────────────────────
        rustcLinkWrapper = pkgs.writeShellScript "rustc-link-wrapper" ''
          ${systemDevDir}
          export SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path 2>/dev/null)"
          exec /usr/bin/cc "$@"
        '';

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

          # JavaScript ツールチェイン
          # （Chrome 拡張 + Tauri フロントエンドで使用）
          nodejs_22 # node / npm（wxt・vite が内部で呼ぶ場面の保険）
          bun # 高速なパッケージマネージャ兼ランタイム

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

              # SDKROOT/DEVELOPER_DIR は Nix 既定（apple-sdk_15）のまま触らない。
              # Nix の cc/clang はこの値（または未設定）でないと C コンパイルが壊れるため。
              # swift コンパイルは下の PATH shim が system SDK へ振り分け、
              # 最終リンクは下の CARGO_..._LINKER ラッパーが system cc を使う。
              export PATH="${pkgs.lib.makeBinPath swiftToolchainShims}:$PATH"

              # rustc の最終リンクを system cc(ld64) に委譲する（Swift auto-link 解決のため）。
              export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="${rustcLinkWrapper}"
            ''}

            echo "──────────────────────────────────────"
            echo "meet-jerky 開発環境が準備できました"
            echo ""
            echo "  Rust:    $(rustc --version)"
            echo "  Cargo:   $(cargo --version)"
            echo "  Node.js: $(node --version)"
            echo "  npm:     $(npm --version)"
            echo "  Bun:     $(bun --version)"
            echo "──────────────────────────────────────"
          '';
        };
      }
    );
}
