---
date: 2020-03-10T15:00:00-00:00
tags: [android,webview]
title: "关于 Androidx 的5.x版本 webview crash"
---



# 关于 Androidx 的5.x版本 webview crash

这两更新了androidx compat 在5.x一下版本手机上遇到crash问题

```
android.content.res.Resources$NotFoundException: String resource ID #0x2040002

```

确定是androidx 1.1.0版本问题 [google issue](https://issuetracker.google.com/issues/141132133)

而且是只有 1.1.0 正式包才会有问题。以后还是少升级这种基础包为好

