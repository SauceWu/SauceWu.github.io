---
date: 2021-08-11T21:10:00+09:00
tags: ["architecture", "ddd", "domain-driven-design", "software-design"]
title: "DDD 是什么：一篇讲清领域驱动设计"
---

# DDD 是什么：一篇讲清领域驱动设计

很多人第一次听到 `DDD`（Domain-Driven Design，领域驱动设计）会觉得它很“玄学”。  
其实它解决的问题非常现实：**业务太复杂，代码开始失真，团队开始说不清同一个概念。**

---

## 一、DDD 到底在解决什么问题

当系统进入复杂业务阶段（交易、支付、风控、订单流转），常见问题会出现：

- 同一个规则在多个地方重复实现
- 接口字段就是业务模型，改字段就改全系统
- “下单”“成交”“结算”这些词，每个人理解都不一样

DDD 的核心目标是：  
**让代码结构贴近业务结构，让业务语言和代码语言一致。**

---

## 二、DDD 的核心概念（只记最关键的）

### 1) 领域（Domain）

你的业务问题空间，比如“交易系统”就是一个领域。

### 2) 统一语言（Ubiquitous Language）

产品、业务、研发使用同一套术语。  
比如 `Order`、`Fill`、`Position` 必须定义一致，避免口头理解和代码实现偏差。

### 3) 限界上下文（Bounded Context）

把大系统切成多个业务边界，比如：

- Trading（交易）
- Wallet（钱包）
- Risk（风控）
- Settlement（结算）

每个上下文内部概念自洽，跨上下文通过清晰契约通信。

### 4) 实体 / 值对象 / 聚合

- 实体（Entity）：有唯一身份（如订单 ID）
- 值对象（Value Object）：只看值，不看身份（如价格、数量）
- 聚合（Aggregate）：一致性边界（哪些数据必须一起保持正确）

---

## 三、DDD 的本质不是“分文件夹”

很多人把 DDD 做成“高级命名规范”，这是误区。  
DDD 真正关键是两件事：

1. **业务边界清楚**
2. **规则归属清楚**

比如“能否下单”的规则应在领域模型，不应散落在 UI、接口层、数据库触发器里。

---

## 四、什么时候该用 DDD

适合：

- 业务规则复杂且经常变化
- 多团队协作，概念容易混乱
- 系统生命周期长，需要可持续演进

不太适合：

- 很小的 CRUD 项目
- 业务逻辑非常轻，页面主导

---

## 五、一句话总结

DDD 不是为了“架构好看”，而是为了在复杂业务里保持系统可理解、可沟通、可演进。  
它的核心价值是：**让业务真相进入代码，而不是只停留在会议里。**

---

## 参考原文

- Eric Evans（DDD 作者）官网与资料入口：<https://domainlanguage.com/>
- Martin Fowler 对 DDD 的经典说明：<https://martinfowler.com/bliki/DomainDrivenDesign.html>
- 微软关于 DDD 的实践指南（微服务场景）：<https://learn.microsoft.com/en-us/azure/architecture/microservices/model/domain-analysis>
