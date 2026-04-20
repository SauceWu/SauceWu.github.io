---
date: 2026-04-20T20:30:00+09:00
tags: ["flutter", "ddd", "clean-architecture", "exchange", "web3"]
title: "Flutter 交易所架构实战：DDD + Clean 落地指南"
---

# Flutter 交易所架构实战：DDD + Clean 落地指南

交易所项目做到一定规模，就会开始还之前欠下的债——页面里写 API、规则到处复制、改一处牵十处。

用 `DDD + Clean` 不是为了架构好看，是因为不用它的话，这类项目很难不失控。

这篇不讲大而空的概念，只讲三个问题：

1. 为什么交易所需要 `DDD + Clean`
2. 在 Flutter 里到底怎么分层
3. 一笔下单请求如何在系统里流转（含时序图）

---

## 一、为什么交易所适合 DDD + Clean

交易所天然是“复杂业务系统”，不是普通内容 App。你会长期面对：

- 订单状态机（New / PartiallyFilled / Filled / Canceled）
- 实时行情推送（WebSocket）
- 风控规则（余额、仓位、价格精度、限价带）
- 多上下文协作（交易、钱包、行情、结算）

如果没有明确边界，最常见结局就是：

- 页面里直接写 API 与业务规则
- 同一规则复制到多个模块
- 一改就牵一发动全身

`DDD` 负责把业务模型建正确，`Clean` 负责把依赖关系管正确。  
两者组合，刚好对症。

---

## 二、先分上下文，再做分层

别先想文件夹，先切业务上下文（Bounded Context）：

- `Trading`：下单、撤单、订单状态流转
- `Market`：K线、深度、ticker
- `Wallet`：充值、提现、资产余额
- `Risk`：规则校验、风控拦截

然后每个上下文内部用 Clean 四层：

- `Presentation`：页面与交互状态
- `Application`：UseCase 编排流程
- `Domain`：实体、值对象、领域规则、仓储接口
- `Data`：HTTP/WS/DB/SDK 具体实现

依赖方向必须固定：

`Presentation -> Application -> Domain`  
`Data -> Domain（实现接口）`

等价写法是：`Presentation -> Application -> Domain <- Data`。  
注意这里不是双向依赖，`Domain` 仍然是最内层，不依赖外层实现。

---

## 三、Flutter 目录怎么落

以交易模块为例，一个可执行模板如下：

```txt
features/trading/
  presentation/
    pages/
    state/                # Notifier / State
  application/
    usecases/             # PlaceOrderUseCase, CancelOrderUseCase
  domain/
    entities/             # Order, Position, TradeFill
    value_objects/        # Price, Quantity, Symbol
    repositories/         # TradingRepository (abstract)
    services/             # RiskCheckService
  data/
    datasources/          # TradingApi, TradingWs
    models/               # DTO
    mappers/              # DTO <-> Entity
    repositories/         # TradingRepositoryImpl
```

一个实用判断标准：  
如果你的页面里出现 `dio.post('/orders')`，分层基本就已经破了。

---

## 四、下单链路时序图（核心）

下面这张图就是 `DDD + Clean` 的核心价值：  
流程清晰、职责独立、边界稳定。

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as Presentation (TradePage/Notifier)
    participant UC as Application (PlaceOrderUseCase)
    participant REPO as Domain Repository (TradingRepository)
    participant RISK as Domain Service (RiskCheckService)
    participant API as DataSource (TradingApi)
    participant DB as Local Cache/DB
    participant WS as WebSocket Stream

    U->>UI: 点击「买入」
    UI->>UC: execute(placeOrderCommand)

    UC->>RISK: validate(command, account, market)
    RISK-->>UC: pass / fail

    alt 校验失败
        UC-->>UI: Result.failure(reason)
        UI-->>U: 展示错误提示
    else 校验通过
        UC->>REPO: placeOrder(command)
        REPO->>API: POST /orders
        API-->>REPO: orderId + status
        REPO->>DB: 保存订单快照
        REPO-->>UC: OrderEntity
        UC-->>UI: Result.success(OrderEntity)
        UI-->>U: 显示下单成功/订单状态

        WS-->>UI: 订单状态推送(PartiallyFilled/Filled)
        UI->>UI: 更新列表与持仓视图
    end
```

---

## 五、三条强约束（别妥协）

### 1) Domain 层不依赖框架

`Domain` 不能依赖 Flutter、Dio、数据库 SDK。  
它只表达业务规则，不表达技术细节。

### 2) UseCase 不直接访问 DataSource

UseCase 只能依赖 `Domain Repository` 接口。  
Data 层在外面实现接口并注入。

### 3) DTO 不进业务层

接口返回结构只在 Data 层存在，必须经过 Mapper 转成 `Domain Entity` 再进入流程。

---

## 六、怎么增量迁移（不是推倒重来）

如果你项目已经很大，不要全量重构，按下面顺序迁移：

1. 新功能先按 `DDD + Clean` 落
2. 高风险链路优先抽（下单、撤单、资金变更）
3. 旧页面逐步替换成 UseCase 调用
4. 最后再清理历史耦合代码

这套做法的好处是：业务不停、风险可控、每周都能看到结构改善。

---

## 七、跨上下文场景怎么编排

实际做下来最绕的是这种场景：`Trading` 下单时，需要引用 `Wallet` 的余额能力和 `Market` 的行情能力。

核心原则只有一句话：  
**在 Application 层编排，在 Domain 层守规则，在 Data 层做实现。**

### 场景 1：下单依赖余额 + 行情（最常见）

比如用户限价买入 BTC，流程建议是：

1. `PlaceOrderUseCase` 接收下单命令（symbol/price/qty/side）
2. 通过 `WalletReadRepository` 查询可用余额
3. 通过 `MarketReadRepository` 获取最新价、最小价格步长、交易对状态
4. 调用 `RiskCheckService` 做领域校验（余额是否足够、精度是否合法、是否超限价带）
5. 校验通过后再调用 `TradingRepository.placeOrder()`
6. 返回 `OrderEntity` 给 UI

这里有个边界细节很重要：  
`PlaceOrderUseCase` 可以同时依赖多个 **Domain 接口**，但不能直接依赖多个 API Client。  
也就是可以“跨上下文读能力”，但不能“跨层直连实现”。

### 场景 2：撤单后释放冻结资金

这个场景常见坑是“订单状态改了，但余额没对齐”。  
推荐做法是把它当成一个应用编排事务：

1. `CancelOrderUseCase` 请求撤单
2. Trading 返回最终状态 `Canceled`
3. UseCase 调用资金域的 `releaseFrozen(orderId)`
4. 成功后统一回写本地状态并刷新 UI

如果你们后端是事件驱动，也可以改成：

- 交易域发 `OrderCanceledEvent`
- 钱包域消费后释放冻结
- 前端靠订单流 + 余额流最终一致

前端不要在 UI 里手动“猜余额”，而是订阅权威状态流。

### 场景 3：行情波动触发风控提示（但不直接改订单）

例如价格短时剧烈波动时，你希望提示用户“当前滑点风险高”。  
这个能力应该是“提示编排”，不是“静默改单”：

1. `Market` 推送波动指标
2. `RiskHintUseCase` 计算提示等级
3. UI 展示 risk banner / toast
4. 用户二次确认后再走下单 UseCase

这样可以避免一个隐患：  
行情模块直接改交易参数，导致行为不可解释、难审计。

### 一个可落地的编排模板

```txt
Presentation (TradePage)
  -> PlaceOrderUseCase
      -> WalletReadRepository (Domain Interface)
      -> MarketReadRepository (Domain Interface)
      -> RiskCheckService (Domain Rule)
      -> TradingRepository (Domain Interface)
```

你可以把它理解成：  
**应用层是“调度台”，领域层是“裁判”，数据层是“执行队”。**

---

## 总结

在交易所场景里，`DDD + Clean` 不是为了“显得高级”，而是为了让系统在复杂规则和高频变更下还能稳定进化。  
先把边界画清，再把流程做薄，架构才会真正服务业务，而不是拖慢业务。
