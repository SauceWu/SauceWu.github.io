---
date: 2026-04-23T16:00:00+09:00
tags: ["flutter", "ios", "testing", "patrol", "ai", "agent", "ci"]
title: "flutter-patrol-pilot：让 AI Agent 自主跑通 Flutter iOS 测试"
---

# flutter-patrol-pilot：让 AI Agent 自主跑通 Flutter iOS 测试

Flutter iOS 的集成测试一直是个麻烦事：Xcode 环境脆、xcresult 日志难读、Patrol 框架有自己的坑、失败原因五花八门。让人类来修还好，让 AI Agent 来修——很容易陷入死循环。

[flutter-patrol-pilot](https://github.com/sauce-wu/flutter-patrol-pilot)（简称 fpp）是一个专门解决这个问题的 Claude Code Agent Skill：它接管整个 Flutter iOS 测试生命周期，从编译到运行，从失败诊断到代码修复，带着硬性规则和停止条件，不进死循环。

---

## 一、Agent 跑测试的四个典型失败模式

在 fpp 之前，让 AI Agent 跑 Flutter 测试几乎必然遇到以下问题：

**1. 篡改断言（Assertion Tampering）**

测试失败 `expect(x, 5)` 实际是 4，Agent 直接改成 `expect(x, 4)`，测试通过了，但逻辑错了。

**2. 失败分类错误（Misclassification）**

构建失败、测试超时、断言失败，在 xcode 日志里看起来都像"红了"，但对应的修法完全不同。分类错了，怎么改都越改越乱。

**3. Token 爆炸（Token Explosion）**

原始 xcresult 日志和 `xcrun simctl spawn` 日志动辄几千行，Agent 每次迭代都塞进 context，6 轮跑下来 context 就满了。

**4. 没有停止条件（No Stop Condition）**

Agent 在 10 个文件、10 次迭代里反复修改，完全没有判断"我已经没有进展"的机制。

fpp 的设计就是为了系统性解决这四个问题。

---

## 二、核心架构：确定性状态机

fpp 的执行流程是一个 7 步状态机：

```
[0] 接收任务
[1] 环境准备（FVM 检测、simulator 启动）
[2] 编译（patrol build ios --simulator）
[3] 运行测试（xcodebuild test-without-building）
[4] 检查结果
     ↓ 失败
[5] 故障分类（MANDATORY，不可跳过）
     ↓
[6] 按分类允许的动作修复
     ↓
[7] 停止条件检查（6 个硬性上限）
     ↓
    继续 → iter++，回到 [2]
    通过 → 完成
```

其中步骤 [5] 是整个设计的核心。

---

## 三、故障分类表：把开放问题变成查表问题

fpp 把所有测试失败映射到 5 个类别，每个类别有明确的允许动作和禁止动作：

| 类别 | 信号特征 | 允许动作 | 禁止动作 |
|------|---------|---------|---------|
| 5-A 构建失败 | xcodebuild exit 65/70，Dart 编译错误 | 修构建配置、Podfile | 先动 app/test 代码 |
| 5-B 超时 | `WaitUntilVisibleTimeoutException` | 增加超时、修路由/滚动 | 删断言、加裸 `sleep()` |
| 5-C 断言失败 | `TestFailure: Expected: X Actual: Y` | 修 app 逻辑 | **绝对禁止改 expected 值** |
| 5-D 环境问题 | simulator 未启动、`patrol: command not found` | 修环境、pod install | 改代码 |
| 5-E 未知 | 信号冲突或解析为空 | 先抓 a11y tree | 任何代码改动 |

5-B 和 5-C 的区分是关键：不看症状，看**异常类名**。
- 抛的是 `TimeoutException` / `WaitUntilVisibleTimeoutException` → 5-B（时序问题）
- 抛的是 `TestFailure` 且有 `Expected:/Actual:` → 5-C（逻辑问题）

这个设计把"Agent 自由发挥"变成了查表：失败信号 → 类别 → 操作集合。

---

## 四、Token 纪律：控制在 30k 以内

每个 shell 脚本只向 stdout 输出**一行 JSON**，完整日志落到 `.test-results/iter-N/*.log`：

```json
{ "success": false, "stage": "xcodebuild_65", "elapsed_s": 47, "log_grep": ["...关键报错行..."] }
```

`parse_failure.py` 在解析 xcresult 时会**剔除 SDK 栈帧**（`package:flutter/`、`package:patrol/`、`dart:` 开头的全丢掉），只保留 app 层的栈帧，体积减少约 70%。

典型的 6 次迭代全程 token 消耗：约 15k，上限 30k。

---

## 五、Xcode 26 的两个隐患及修复

fpp v0.3 内置了两个 Xcode 26 + Flutter 的已知坑：

**坑 1：objectVersion 兼容性**

Xcode 26 写入的 `project.pbxproj` 中 `objectVersion = 70`，但 CocoaPods 的 xcodeproj gem（1.16.x）最高只识别到 63。`build.sh` 在 `pod install` 前自动把 objectVersion 降回 60。

**坑 2：dyld 崩溃**

Xcode 26 引入了 `_Testing_Foundation.framework` 和 `lib_TestingInterop.dylib`，但 Flutter 的构建产物不包含它们。App 在 iOS 26 模拟器上启动时 dyld 崩溃，XCUITest 卡在"Wait for bundle to idle"长达 6 分钟。`build.sh` 在 `xcrun simctl install` 前自动把这两个文件注入到 `Runner.app/Frameworks/` 和 `RunnerUITests-Runner.app/Frameworks/`。

两个坑都是 Agent 看不见的失败——测试"挂住"，没有明确报错。fpp 把修复固化在脚本里，Agent 无需感知。

---

## 六、停止条件：不进死循环

fpp 有 6 个硬性停止条件，任何一个触发就停止并报告：

1. 达到最大迭代次数（默认 6）
2. 同一个测试的同类故障连续出现 3 次
3. 连续 2 次修改没有缩小错误面
4. 修改行数超过阈值
5. 修改文件数超过阈值
6. 5-E 未知类别持续无法诊断

条件 3 最关键：如果两次修改都没有减少失败测试数或缩短错误栈，自动 `git stash` 回滚到 `last_known_good_commit`，停止并等人介入。

---

## 快速上手

```bash
# 全局安装
git clone https://github.com/sauce-wu/flutter-patrol-pilot ~/.claude/skills/flutter-patrol-pilot

# 或在项目 CLAUDE.md 里激活
# 见 templates/CLAUDE_md_snippet.md

# 然后在 Claude Code 里说：
# "test Flutter on iOS simulator"
# "run fpp"
```

触发后 Agent 会自动完成：环境检查 → 编译 → 运行 → 诊断 → 修复 → 迭代。

<!-- buddy: *blinks slowly* 故障分类表那段是整篇文章最硬核的地方，说清楚了为什么这比让 agent 自由发挥强 -->
