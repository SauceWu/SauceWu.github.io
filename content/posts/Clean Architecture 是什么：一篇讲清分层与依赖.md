---
date: 2021-09-04T21:20:00+09:00
tags: ["architecture", "clean-architecture", "software-design", "flutter"]
title: "Clean Architecture 是什么：一篇讲清分层与依赖"
---

# Clean Architecture 是什么：一篇讲清分层与依赖

`Clean Architecture` 常被说成“分层架构”，但它最关键的不是分层本身，而是：  
**依赖方向必须可控。**

---

## 一、Clean 想解决什么问题

项目变大后，最容易失控的是依赖关系：

- 页面直接调 API
- 业务规则写在网络回调里
- 换个数据库或 SDK，核心逻辑跟着重写

Clean 的核心目标是：  
**让核心业务不依赖外部框架和实现细节。**

---

## 二、经典四层怎么理解

### 1) Presentation（表现层）

页面、组件、状态管理。  
负责“怎么展示”和“怎么交互”。

### 2) Application（应用层）

UseCase（用例）编排流程。  
负责“做什么流程”，不负责“怎么请求网络”。

### 3) Domain（领域层）

实体、业务规则、仓储接口。  
这是最稳定、最核心的一层。

### 4) Data / Infrastructure（数据/基础设施层）

HTTP、DB、缓存、第三方 SDK 的具体实现。  
这些都是可替换细节。

---

## 三、最重要规则：依赖只能向内

正确方向：

`Presentation -> Application -> Domain`  
`Data -> Domain（实现接口）`

错误方向：

- Domain import Flutter/Dio
- UseCase 直接调用 API client
- UI 直接操作 DataSource

只要依赖方向错了，后面再“重构目录”也没用。

---

## 四、Clean 的优势和代价

优势：

- 可测试性高（Domain/UseCase 可单测）
- 可替换性强（换网络层/DB 成本低）
- 大团队协作更稳

代价：

- 初期样板代码多
- 对小项目可能偏重
- 团队需要统一规范

---

## 五、什么时候适合用 Clean

适合：

- 中大型项目
- 长期维护项目
- 业务变更频繁项目

不太适合：

- 小型短期项目
- 页面极少、逻辑很轻的工具应用

---

## 六、一句话总结

Clean Architecture 的本质是“依赖治理”。  
它不是让你写更多层，而是让你在项目变大后还能稳住边界，不被技术细节反向绑架。

---

## 参考原文

- Uncle Bob《The Clean Architecture》原文：<https://blog.cleancoder.com/uncle-bob/2011/11/22/Clean-Architecture.html>
- Robert C. Martin《Clean Architecture》书籍页：<https://www.pearson.com/en-us/subject-catalog/p/clean-architecture/P200000009481/9780134494272>
- Uncle Bob 的同源延展（Screaming Architecture）：<https://blog.cleancoder.com/uncle-bob/2011/09/30/Screaming-Architecture.html>
