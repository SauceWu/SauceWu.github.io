---
date: 2026-04-17T18:00:00-00:00
tags: ["flutter", "ci", "github-actions", "ffi"]
title: "Flutter FFI 插件的 GitHub CI 实践：以 ceres-wallet-core 为例"
---

# Flutter FFI 插件的 GitHub CI 实践：以 ceres-wallet-core 为例

## 背景

普通 Flutter 插件的 CI 很简单：跑一下 `flutter test` 就够了。但 Flutter FFI 插件夹着 C++/Rust native 库，问题就复杂得多——

- native 库需要在 macOS 上编译 iOS，在 Linux 上编译 Android，不能混
- 编译一次要十几分钟，开发者 `pub get` 的时候不能让他们自己编
- Trust Wallet Core 有几十万行 C++ 代码，子模块更新需要自动化

ceres-wallet-core 的解法是两条 workflow：

| Workflow | 触发条件 | 职责 |
|----------|---------|------|
| `build-native.yml` | 推送 `v*` tag | 编译各平台 native 库，上传到 GitHub Release |
| `update-submodule.yml` | 手动触发 / repository_dispatch | 同步上游 wallet-core，自动 bump 版本 |

开发者接入时，`hook/build.dart` 在 `flutter pub get` 阶段自动从 Release 下载对应版本的预编译产物，不需要本地装任何 C++ 工具链。

---

## build-native.yml：编译 native 库

### 整体结构

```yaml
name: Build Native Libraries

on:
  push:
    tags:
      - 'v*'   # 只有打 tag 时才触发编译

jobs:
  build-ios:
    runs-on: macos-latest   # iOS 必须在 macOS 上编译
    ...

  build-android:
    runs-on: ubuntu-latest  # Android 在 Linux 上编译更快
    ...

  release:
    needs: [build-ios, build-android]
    runs-on: ubuntu-latest
    ...
```

iOS 和 Android 并行编译，都完成后再合并发布，节省总时间。

### iOS 编译 Job

```yaml
build-ios:
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4
      with:
        submodules: recursive   # 拉取 wallet-core 子模块，代码量很大，要等一会

    - name: Install Rust nightly
      uses: dtolnay/rust-toolchain@nightly
      with:
        targets: aarch64-apple-ios,aarch64-apple-ios-sim,x86_64-apple-ios

    - name: Install dependencies
      run: brew install cmake ninja protobuf boost cbindgen

    - name: Build iOS
      run: bash tool/build_native.sh ios

    - name: Upload iOS artifact
      uses: actions/upload-artifact@v4
      with:
        name: ios-libs
        path: dist/ios/
```

iOS 需要编译两个 target：
- `aarch64-apple-ios`：真机
- `aarch64-apple-ios-sim` + `x86_64-apple-ios`：模拟器（合并成 XCFramework）

### Android 编译 Job

```yaml
build-android:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        submodules: recursive

    - name: Install Rust nightly
      uses: dtolnay/rust-toolchain@nightly
      with:
        targets: aarch64-linux-android,armv7-linux-androideabi,x86_64-linux-android

    - name: Setup Android NDK
      uses: android-actions/setup-android@v3

    - name: Install dependencies
      run: sudo apt-get install -y cmake ninja-build protobuf-compiler libboost-all-dev

    - name: Build Android
      run: bash tool/build_native.sh android

    - name: Upload Android artifact
      uses: actions/upload-artifact@v4
      with:
        name: android-libs
        path: dist/android/
```

Android 需要编译三个 ABI：`arm64-v8a`、`armeabi-v7a`、`x86_64`，对应真机、32 位机和模拟器。

### Release Job：合并产物发布

```yaml
release:
  needs: [build-ios, build-android]
  runs-on: ubuntu-latest
  permissions:
    contents: write
  steps:
    - name: Download iOS libs
      uses: actions/download-artifact@v4
      with:
        name: ios-libs
        path: dist/ios/

    - name: Download Android libs
      uses: actions/download-artifact@v4
      with:
        name: android-libs
        path: dist/android/

    - name: Create GitHub Release
      uses: softprops/action-gh-release@v2
      with:
        files: |
          dist/ios/*.tar.gz
          dist/android/*.tar.gz
        generate_release_notes: true
```

产物结构：

```
dist/
  ios/
    WalletCore-ios.tar.gz        # XCFramework（device + simulator）
  android/
    WalletCore-android.tar.gz    # 三个 ABI 的 .so 文件
```

---

## update-submodule.yml：自动跟进上游

Trust Wallet Core 更新很频繁，手动同步子模块太麻烦。这个 workflow 做自动化：

```yaml
name: Update Wallet Core Submodule

on:
  repository_dispatch:
    types: [update-wallet-core]   # 可被外部 webhook 触发
  workflow_dispatch:              # 也支持手动触发
    inputs:
      force:
        description: 'Force update even if no changes'
        default: 'false'

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Update submodule to latest
        run: |
          cd third_party/wallet-core
          git fetch origin
          git checkout origin/main

      - name: Check for changes
        id: changes
        run: |
          if git diff --quiet; then
            echo "changed=false" >> $GITHUB_OUTPUT
          else
            echo "changed=true" >> $GITHUB_OUTPUT
          fi

      - name: Bump patch version
        if: steps.changes.outputs.changed == 'true'
        run: |
          VERSION=$(grep '^version:' pubspec.yaml | sed 's/version: //')
          PATCH=$(echo $VERSION | cut -d. -f3)
          NEW_PATCH=$((PATCH + 1))
          NEW_VERSION=$(echo $VERSION | sed "s/\.[0-9]*$/.${NEW_PATCH}/")
          sed -i "s/^version: .*/version: ${NEW_VERSION}/" pubspec.yaml
          echo "New version: ${NEW_VERSION}"

      - name: Commit and tag
        if: steps.changes.outputs.changed == 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add third_party/wallet-core pubspec.yaml
          git commit -m "chore: update wallet-core submodule, bump version"
          NEW_VERSION=$(grep '^version:' pubspec.yaml | sed 's/version: //')
          git tag "v${NEW_VERSION}"
          git push origin HEAD --tags
```

推送的 tag 会触发 `build-native.yml`，形成完整的自动化链路：

```
上游 wallet-core 更新
  → update-submodule.yml 同步子模块 + bump 版本 + 推 tag
    → build-native.yml 编译 native 库 + 发布 Release
      → 用户 flutter pub get 时 build hook 自动下载新产物
```

---

## build.dart：分发预编译产物

这是整套方案的最后一环。Flutter 的 Native Assets 特性支持在 `pub get` 时执行一个 `hook/build.dart`：

```dart
// hook/build.dart
import 'package:code_assets/code_assets.dart';
import 'package:hooks/hooks.dart';

void main(List<String> args) async {
  await build(args, (input, output) async {
    final version = input.packageVersion;  // 读取 pubspec.yaml 的版本号
    final os = input.config.code.targetOS;

    // 从 GitHub Release 下载对应版本的预编译库
    final url = 'https://github.com/SauceWu/ceres-wallet-core/'
        'releases/download/v$version/'
        'WalletCore-${os.name}.tar.gz';

    await downloadAndExtract(url, output);

    // 告诉 Flutter 把这个 native 库打包进 App
    output.assets.code.add(
      CodeAsset(
        package: 'ceres_wallet_core',
        name: 'libWalletCore',
        file: extractedLibPath,
        linkMode: DynamicLoadingBundled(),
      ),
    );
  });
}
```

效果：接入方只需要在 `pubspec.yaml` 里加一行依赖，`flutter pub get` 时自动下载对应平台的 native 库，完全不需要在本地安装 Rust、CMake 或 Android NDK。

---

## 几个值得借鉴的细节

**1. 子模块 checkout 要加 recursive**

```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive  # 漏掉这行，native 代码根本不存在
    fetch-depth: 0         # 完整历史，tag 触发时需要
```

**2. Rust toolchain 缓存**

Rust 编译很慢，加缓存能节省大量时间：

```yaml
- uses: Swatinem/rust-cache@v2
  with:
    workspaces: third_party/wallet-core/rust
```

**3. 并行编译 + artifact 传递**

iOS 和 Android 并行跑，用 `upload-artifact` / `download-artifact` 在 job 之间传文件，比串行快一倍。

**4. Release 权限**

创建 Release 需要在 job 层声明写权限：

```yaml
jobs:
  release:
    permissions:
      contents: write  # 漏掉会报 403
```

**5. 只在 tag 时触发编译**

native 编译耗时且耗资源，不应该每次 push 都跑。用 `tags: ['v*']` 过滤，只有打版本 tag 时才触发。

---

## 完整流程回顾

```
开发者推送 v0.1.2 tag
        ↓
build-native.yml 触发
  ├── build-ios (macOS)     ─┐
  └── build-android (Linux) ─┤ 并行
                             ↓
                      release job 合并
                             ↓
              GitHub Release v0.1.2
              ├── WalletCore-ios.tar.gz
              └── WalletCore-android.tar.gz
                             ↓
       用户 flutter pub get
              ↓
       hook/build.dart 检测版本
              ↓
       下载对应平台 tar.gz 并解压
              ↓
       Flutter 打包进 App ✓
```
