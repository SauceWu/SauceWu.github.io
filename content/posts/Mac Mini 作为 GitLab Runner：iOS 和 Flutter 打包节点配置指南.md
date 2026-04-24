---
date: 2026-04-24T12:00:00+09:00
tags: ["gitlab", "ci", "ios", "flutter", "devops", "mac-mini", "runner"]
title: "Mac Mini 作为 GitLab Runner：iOS 和 Flutter 打包节点配置指南"
---

# Mac Mini 作为 GitLab Runner：iOS 和 Flutter 打包节点配置指南

iOS 和 Flutter 项目的 CI 有一个绕不开的限制：**必须在 macOS 上构建**。云端 macOS 实例贵，自建 Mac Mini 作为 GitLab Runner 是最常见的低成本方案。

这篇文章记录从零把一台 Mac Mini 配置成 GitLab CI 打包节点的完整过程，覆盖环境安装、Runner 注册、`.gitlab-ci.yml` 配置、常见坑和维护建议。

---

## 一、硬件与系统建议

**机型选择：**
- Apple Silicon（M2/M4 Mac Mini）是当前最优选：编译速度比 Intel 快 2–3 倍，功耗低，适合长期挂机
- 内存至少 16GB，Flutter + Xcode 同时运行内存压力大
- 存储推荐 256GB+，DerivedData 和模拟器镜像会吃掉大量空间

**系统设置：**
- macOS 保持最新稳定版（Sequoia / Tahoe），和 Xcode 版本绑定
- 关闭自动睡眠：`系统设置 → 电池 → 防止电脑自动进入睡眠`
- 打开远程登录（SSH）：`系统设置 → 通用 → 共享 → 远程登录`

---

## 二、环境安装

### 1. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Apple Silicon 安装路径是 `/opt/homebrew/bin`，需要加入 PATH：

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
source ~/.zprofile
```

### 2. Xcode

从 App Store 安装 Xcode，安装完成后接受许可协议并安装命令行工具：

```bash
sudo xcodebuild -license accept
xcode-select --install
```

验证：

```bash
xcodebuild -version
# Xcode 16.x
```

### 3. Flutter（推荐用 FVM 管理）

FVM 允许不同项目使用不同 Flutter 版本，避免版本冲突：

```bash
brew tap leoafarias/fvm
brew install fvm

# 安装指定版本
fvm install 3.32.0
fvm global 3.32.0
```

验证：

```bash
flutter doctor
```

### 4. CocoaPods

```bash
sudo gem install cocoapods
```

Apple Silicon 上 gem 路径问题偶发，如果安装后找不到 `pod` 命令：

```bash
# 检查 gem 安装路径
gem environment
# 把 GEM_HOME/bin 加入 PATH
```

### 5. GitLab Runner

```bash
brew install gitlab-runner
```

---

## 三、注册 Runner

在 GitLab 项目或 Group 里获取 Runner token：
`Settings → CI/CD → Runners → New project runner`

注册：

```bash
gitlab-runner register \
  --url "https://gitlab.com" \
  --token "glrt-xxxxxxxxxxxxxxxx" \
  --executor "shell" \
  --description "mac-mini-m4-ios" \
  --tag-list "ios,flutter,macos" \
  --run-untagged false
```

**Executor 选 `shell`**，不要用 Docker——macOS 上 Docker 无法访问 Xcode 和模拟器。

注册完成后以服务方式启动（重启后自动拉起）：

```bash
brew services start gitlab-runner
```

验证 Runner 在线：
GitLab → Settings → CI/CD → Runners，状态显示绿色。

---

## 四、`.gitlab-ci.yml` 配置

### 完整 CI 脚本

以下是一份可直接放入项目根目录的 `.gitlab-ci.yml`，覆盖测试、Android 打包、iOS 打包、构建产物清理四个阶段：

```yaml
# .gitlab-ci.yml
# 适用于 Mac Mini GitLab Runner（shell executor）
# Runner tag: ios, flutter, macos
#
# 所需 CI/CD Variables（Settings → CI/CD → Variables）：
#   PROVISIONING_PROFILE_BASE64  — iOS Provisioning Profile 的 base64 编码（masked）
#   FIREBASE_TOKEN               — Firebase CLI token（masked）
#   FIREBASE_ANDROID_APP_ID      — Firebase Android App ID（如 1:123456:android:abcdef）
#   FIREBASE_IOS_APP_ID          — Firebase iOS App ID
#   SLACK_WEBHOOK_URL            — Slack Incoming Webhook URL（masked）
#   DINGTALK_WEBHOOK_URL         — 钉钉机器人 Webhook URL（masked，二选一）

stages:
  - test
  - build
  - deploy
  - notify
  - cleanup

variables:
  FLUTTER_VERSION: "3.32.0"
  PATH_PREFIX: "/opt/homebrew/bin:/opt/homebrew/sbin:$HOME/.fvm/versions/$FLUTTER_VERSION/bin"

# ── 公共前置步骤 ──────────────────────────────────────────────
.flutter_base:
  tags:
    - ios
    - flutter
    - macos
  before_script:
    - export PATH="$PATH_PREFIX:$PATH"
    - flutter --version
    - flutter pub get
  resource_group: ios_build

# ── 单元测试 ──────────────────────────────────────────────────
unit_test:
  stage: test
  extends: .flutter_base
  script:
    - flutter test --coverage
  coverage: '/lines\s*:\s*(\d+\.\d+)%/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura.xml
    expire_in: 3 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main"'

# ── Android 打包 ──────────────────────────────────────────────
build_android:
  stage: build
  extends: .flutter_base
  script:
    - flutter build apk --release --obfuscate
        --split-debug-info=build/debug-info/android
  artifacts:
    name: "android-$CI_COMMIT_SHORT_SHA"
    paths:
      - build/app/outputs/flutter-apk/app-release.apk
      - build/debug-info/android/
    expire_in: 14 days
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
    - if: '$CI_COMMIT_BRANCH =~ /^release\//'

# ── iOS 打包 ──────────────────────────────────────────────────
build_ios:
  stage: build
  extends: .flutter_base
  script:
    - |
      if [ -n "$PROVISIONING_PROFILE_BASE64" ]; then
        PP_PATH="$HOME/Library/MobileDevice/Provisioning Profiles"
        mkdir -p "$PP_PATH"
        echo "$PROVISIONING_PROFILE_BASE64" | base64 --decode > "$PP_PATH/app.mobileprovision"
      fi
    - cd ios && pod install && cd ..
    - flutter build ipa --release --obfuscate
        --split-debug-info=build/debug-info/ios
        --export-options-plist=ios/ExportOptions.plist
  artifacts:
    name: "ios-$CI_COMMIT_SHORT_SHA"
    paths:
      - build/ios/ipa/*.ipa
      - build/debug-info/ios/
    expire_in: 14 days
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
    - if: '$CI_COMMIT_BRANCH =~ /^release\//'

# ── 上传 Android → Firebase App Distribution ─────────────────
deploy_android:
  stage: deploy
  tags: [macos]
  needs: [build_android]        # 直接依赖 build_android，不等 iOS
  script:
    - export PATH="$PATH_PREFIX:$PATH"
    # 安装 Firebase CLI（已安装则跳过）
    - command -v firebase || brew install firebase-cli
    - firebase appdistribution:distribute
        build/app/outputs/flutter-apk/app-release.apk
        --app "$FIREBASE_ANDROID_APP_ID"
        --token "$FIREBASE_TOKEN"
        --groups "internal-testers"
        --release-notes "Branch: $CI_COMMIT_BRANCH | Commit: $CI_COMMIT_SHORT_SHA"
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
    - if: '$CI_COMMIT_BRANCH =~ /^release\//'

# ── 上传 iOS → TestFlight ────────────────────────────────────
# 开关：UPLOAD_TO_TESTFLIGHT = "true" 时才上传（默认关闭）
# 所需变量：
#   ASC_API_KEY_ID     — App Store Connect API Key ID
#   ASC_API_KEY_BASE64 — .p8 私钥文件的 base64 编码（masked）
#   ASC_API_ISSUER     — API Key 的 Issuer ID
deploy_testflight:
  stage: deploy
  tags: [macos]
  needs: [build_ios]
  script:
    - export PATH="$PATH_PREFIX:$PATH"
    # 恢复 .p8 私钥
    - mkdir -p ~/.appstoreconnect/private_keys
    - echo "$ASC_API_KEY_BASE64" | base64 --decode
        > ~/.appstoreconnect/private_keys/AuthKey_${ASC_API_KEY_ID}.p8
    # 上传到 TestFlight（xcrun altool，无需 Fastlane）
    - xcrun altool --upload-app
        -f "$(ls build/ios/ipa/*.ipa | head -1)"
        -t ios
        --apiKey  "$ASC_API_KEY_ID"
        --apiIssuer "$ASC_API_ISSUER"
    # 清理私钥，不留在磁盘
    - rm -f ~/.appstoreconnect/private_keys/AuthKey_${ASC_API_KEY_ID}.p8
  rules:
    - if: '$UPLOAD_TO_TESTFLIGHT != "true"'
      when: never                              # 开关未打开，直接跳过
    - if: '$CI_COMMIT_BRANCH =~ /^release\//' # release 分支 + 开关开启才执行

# ── 上传 iOS → App Store 正式审核 ────────────────────────────
# 开关：UPLOAD_TO_APPSTORE = "true" 时才提交（默认关闭，避免误触）
# 复用同一套 ASC API Key 变量
deploy_appstore:
  stage: deploy
  tags: [macos]
  needs: [build_ios]
  script:
    - export PATH="$PATH_PREFIX:$PATH"
    - mkdir -p ~/.appstoreconnect/private_keys
    - echo "$ASC_API_KEY_BASE64" | base64 --decode
        > ~/.appstoreconnect/private_keys/AuthKey_${ASC_API_KEY_ID}.p8
    # 上传 + 自动提交审核
    - xcrun altool --upload-app
        -f "$(ls build/ios/ipa/*.ipa | head -1)"
        -t ios
        --apiKey  "$ASC_API_KEY_ID"
        --apiIssuer "$ASC_API_ISSUER"
    - rm -f ~/.appstoreconnect/private_keys/AuthKey_${ASC_API_KEY_ID}.p8
  when: manual              # 必须在 GitLab UI 手动点击才会执行，永远不会自动触发
  allow_failure: true       # 不点也不影响 pipeline 整体结果
  rules:
    - if: '$CI_COMMIT_BRANCH =~ /^release\//'

# ── 通知：Slack ───────────────────────────────────────────────
notify_slack:
  stage: notify
  tags: [macos]
  needs: [deploy_android, deploy_ios]
  when: always    # 成功或失败都通知
  script:
    - |
      if [ "$CI_JOB_STATUS" == "success" ] || [ -z "$CI_JOB_STATUS" ]; then
        STATUS_EMOJI=":white_check_mark:"
        STATUS_TEXT="构建成功"
        COLOR="good"
      else
        STATUS_EMOJI=":x:"
        STATUS_TEXT="构建失败"
        COLOR="danger"
      fi

      # 判断上游 job 是否有失败
      PREV_FAILED=""
      [ "$DEPLOY_ANDROID_STATUS" = "failed" ] && PREV_FAILED="Android 上传失败"
      [ "$DEPLOY_IOS_STATUS" = "failed" ] && PREV_FAILED="$PREV_FAILED iOS 上传失败"

      curl -s -X POST "$SLACK_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{
          \"attachments\": [{
            \"color\": \"$COLOR\",
            \"title\": \"$STATUS_EMOJI $CI_PROJECT_NAME — $STATUS_TEXT\",
            \"fields\": [
              {\"title\": \"分支\",   \"value\": \"$CI_COMMIT_BRANCH\",    \"short\": true},
              {\"title\": \"Commit\", \"value\": \"$CI_COMMIT_SHORT_SHA\", \"short\": true},
              {\"title\": \"提交信息\",\"value\": \"$CI_COMMIT_MESSAGE\",  \"short\": false}
            ],
            \"footer\": \"GitLab CI | <$CI_PIPELINE_URL|查看 Pipeline>\"
          }]
        }"
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
    - if: '$CI_COMMIT_BRANCH =~ /^release\//'
    - if: '$SLACK_WEBHOOK_URL == null'
      when: never

# ── 通知：钉钉（与 Slack 二选一）────────────────────────────
notify_dingtalk:
  stage: notify
  tags: [macos]
  needs: [deploy_android, deploy_ios]
  when: always
  script:
    - |
      PIPELINE_RESULT="成功 ✅"
      [ "$CI_JOB_STATUS" != "success" ] && PIPELINE_RESULT="失败 ❌"

      curl -s -X POST "$DINGTALK_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{
          \"msgtype\": \"markdown\",
          \"markdown\": {
            \"title\": \"$CI_PROJECT_NAME 构建通知\",
            \"text\": \"### $CI_PROJECT_NAME 构建$PIPELINE_RESULT\n> **分支**：$CI_COMMIT_BRANCH\n> **Commit**：$CI_COMMIT_SHORT_SHA\n> **提交信息**：$CI_COMMIT_MESSAGE\n> [查看 Pipeline]($CI_PIPELINE_URL)\"
          }
        }"
  rules:
    - if: '$DINGTALK_WEBHOOK_URL != null && ($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_BRANCH =~ /^release\//)'

# ── 通知：Telegram ───────────────────────────────────────────
# 所需变量：
#   TG_BOT_TOKEN — BotFather 创建 bot 后拿到的 token（masked）
#   TG_CHAT_ID   — 目标 chat/group/channel 的 ID（可用 @userinfobot 查）
notify_telegram:
  stage: notify
  tags: [macos]
  needs: [deploy_android, deploy_ios]
  when: always
  script:
    - |
      if [ "$CI_JOB_STATUS" = "success" ] || [ -z "$CI_JOB_STATUS" ]; then
        ICON="✅"
        RESULT="成功"
      else
        ICON="❌"
        RESULT="失败"
      fi

      TEXT="${ICON} *${CI_PROJECT_NAME}* 构建${RESULT}
      
📌 *分支*: \`${CI_COMMIT_BRANCH}\`
🔖 *Commit*: \`${CI_COMMIT_SHORT_SHA}\`
💬 *提交信息*: ${CI_COMMIT_MESSAGE}
🔗 [查看 Pipeline](${CI_PIPELINE_URL})"

      curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TG_CHAT_ID}" \
        -d "parse_mode=Markdown" \
        --data-urlencode "text=${TEXT}"
  rules:
    - if: '$TG_BOT_TOKEN == null'
      when: never
    - if: '$CI_COMMIT_BRANCH == "main"'
    - if: '$CI_COMMIT_BRANCH =~ /^release\//'

# ── 构建后清理 ────────────────────────────────────────────────
cleanup:
  stage: cleanup
  tags: [macos]
  script:
    - rm -rf ~/Library/Developer/Xcode/DerivedData
    - xcrun simctl delete unavailable
    - flutter clean
  when: always
  allow_failure: true
```

**Pipeline 执行顺序：**

```
test ──→ build (android + ios 并行) ──→ deploy (各自独立上传) ──→ notify ──→ cleanup
```

`deploy_android` 和 `deploy_ios` 用 `needs` 声明直接依赖各自的 build job，不互相等待，两条上传并行跑。

**几个设计决策说明：**

- `resource_group: ios_build` — 保证同一 Runner 上不会同时跑两个 iOS 构建，避免 DerivedData 和模拟器端口冲突
- `--obfuscate --split-debug-info` — Release 包开混淆，符号表单独存 artifacts，崩溃时可用 `flutter symbolize` 还原堆栈
- Provisioning Profile 通过 Base64 环境变量注入，不落 Git
- `notify` 用 `when: always`，成功和失败都发通知；Slack 和钉钉通过判断环境变量是否存在来决定用哪个

### iOS 打包需要的额外配置

### iOS 打包需要的额外配置

iOS 打包必须有签名证书和 Provisioning Profile，有两种管理方式：

**方式 A：手动安装证书（简单，适合小团队）**

在 Mac Mini 上用钥匙串手动安装 `.p12` 证书和 `.mobileprovision` 文件，CI 任务直接读取本地钥匙串。

**方式 B：Fastlane Match（推荐，适合团队协作）**

```bash
brew install fastlane
```

`Matchfile`：
```ruby
git_url("https://gitlab.com/yourorg/ios-certificates")
storage_mode("git")
type("appstore")
app_identifier(["com.yourapp.bundle"])
```

`.gitlab-ci.yml` 中调用：
```yaml
build_ios:
  script:
    - bundle exec fastlane match appstore --readonly
    - flutter build ipa --release
      --export-options-plist=ios/ExportOptions.plist
```

---

## 五、常见问题

### 问题 1：`flutter: command not found`

Runner 以 `gitlab-runner` 用户或 launchd 服务运行，PATH 和你的 terminal 不同。

解决：在 `.gitlab-ci.yml` 的 `before_script` 中显式设置 PATH：

```yaml
before_script:
  - export PATH="/opt/homebrew/bin:$HOME/.fvm/versions/3.32.0/bin:$PATH"
```

### 问题 2：`xcodebuild: error: SDK 'iphoneos' cannot be located`

通常是 `xcode-select` 指向错误路径：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### 问题 3：CocoaPods `pod install` 失败

DerivedData 和 Pods 缓存过期是常见原因：

```yaml
before_script:
  - cd ios && pod install --repo-update && cd ..
```

对于 Xcode 26，还需要降级 objectVersion（见上文 flutter-patrol-pilot 那篇的说明）。

### 问题 4：多个 Job 同时跑冲突

Shell executor 默认并发运行多个 Job，iOS 构建并发会冲突（模拟器端口、DerivedData）。

限制 Runner 同时只跑 1 个 Job：

```bash
# /etc/gitlab-runner/config.toml
[[runners]]
  concurrent = 1
```

或者配置 Job 锁（同一 Runner 上的同类 Job 串行）：

```yaml
build_ios:
  resource_group: ios_build  # 同 resource_group 的 Job 不并发
```

### 问题 5：磁盘满

DerivedData 和模拟器镜像会悄悄吃掉几十 GB。建议加一个定期清理的 Job：

```yaml
cleanup:
  stage: .post
  tags: [macos]
  script:
    - rm -rf ~/Library/Developer/Xcode/DerivedData
    - xcrun simctl delete unavailable
  when: always
  allow_failure: true
```

---

## 六、安全注意事项

- **证书不要提交 Git**，用 GitLab CI/CD Variables（masked）或 Fastlane Match 管理
- Runner token 不要硬写在配置文件里，用 `RUNNER_TOKEN` 环境变量注入
- 如果 Mac Mini 在公网，建议只开 SSH，Runner 本身不需要开放任何端口（它是 outbound 连接 GitLab）
- 定期检查 GitLab Runner 版本：`gitlab-runner --version`，保持和 GitLab 服务端版本接近

---

## 七、维护建议

**日志查看：**

```bash
# Runner 实时日志
gitlab-runner --debug run

# 或 macOS 系统日志
tail -f /usr/local/var/log/gitlab-runner.log
```

**Runner 状态：**

```bash
brew services info gitlab-runner
```

**定期清理磁盘**（建议每周）：

```bash
# DerivedData
rm -rf ~/Library/Developer/Xcode/DerivedData

# 模拟器
xcrun simctl delete unavailable

# Flutter 构建缓存
flutter clean
```

**Xcode 更新**：更新 Xcode 后必须重新运行 `sudo xcodebuild -license accept` 和 `xcode-select`，否则 CI Job 会报授权错误。

---

## 小结

Mac Mini 作为 GitLab Runner 的核心配置要点：

1. Executor 必须选 `shell`，不能用 Docker
2. PATH 在 `.gitlab-ci.yml` 里显式设置，不依赖 shell profile
3. 签名证书用 Fastlane Match 管理，不要本机手动维护
4. 并发设为 1，避免 iOS 构建冲突
5. 定期清理 DerivedData 和模拟器，防止磁盘满

一台 M4 Mac Mini（16GB）跑 Flutter iOS 打包，单次构建大约 3–5 分钟，适合中小型团队的 CI 需求。
