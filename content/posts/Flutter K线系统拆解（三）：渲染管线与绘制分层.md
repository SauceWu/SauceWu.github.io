---
date: 2025-04-01T13:00:00+09:00
tags: ["flutter", "kline", "rendering", "custompainter", "pipeline"]
title: "Flutter K线系统拆解（三）：渲染管线与绘制分层"
---

# Flutter K线系统拆解（三）：渲染管线与绘制分层

这一篇聚焦渲染层最关键的问题：  
如何把复杂 K 线绘制从“巨型 paint 方法”重构成可维护、可扩展、可定位问题的阶段化系统。

---

## 一、渲染底座：先算清楚，再开始画

一帧绘制开始前，建议先完成 5 件事：

1. 计算绘制区域（主图、成交量、副图）
2. 根据缩放和滚动计算可视区索引范围
3. 在可视区内扫描 max/min（主图、vol、副图）
4. 初始化渲染器
5. 构建并执行渲染管线

其中最影响性能的是两点：

- 像素坐标反推数据索引
- 只绘制可见区，不遍历全量数据

滚动和缩放能否稳定流畅，基本就看这一步是否扎实。

---

## 二、渲染器组装：把“画什么”与“怎么调度”分开

渲染层建议把主图、成交量、副图拆成独立渲染器，由装配层按当前模式组合：

- 主图：`CandleRenderer` 或 `TimeLineRenderer`
- 成交量：`VolRenderer`
- 副图：`SecondaryRenderer`

再通过策略层控制是否启用某些区域（比如成交量、副图）。

一个实用的装配模板可以长这样：

```dart
class ChartRendererBundle {
  final BaseChartRenderer main;
  final VolRenderer? vol;
  final SecondaryRenderer? secondary;

  ChartRendererBundle({
    required this.main,
    this.vol,
    this.secondary,
  });
}

ChartRendererBundle buildRenderers({
  required bool isTimeLine,
  required bool showVol,
  required bool showSecondary,
}) {
  final main = isTimeLine ? TimeLineRenderer(...) : CandleRenderer(...);
  return ChartRendererBundle(
    main: main,
    vol: showVol ? VolRenderer(...) : null,
    secondary: showSecondary ? SecondaryRenderer(...) : null,
  );
}
```

这段代码背后的设计重点是：  
**渲染器选择在初始化阶段完成，不在每一帧绘制里反复判断。**

这样做的价值是：

- 换主图画法时，不影响整体调度
- 新增渲染器时，不需要改已有阶段逻辑
- 模式分支不再散落在各个绘制细节里

另外建议把“模式差异”统一放进策略层，而不是放进 renderer 内部：

```dart
abstract class ChartModeStrategy {
  bool get hasVolSecondary;
  bool allowTimeLine(bool request);
}
```

这样现货/合约切换时，变的是策略，不是整条渲染链路。

---

## 三、渲染管线：阶段化执行替代硬编码顺序

更可维护的方式是把一帧绘制拆成有序阶段，每个阶段只做一件事，并允许按条件跳过。

典型阶段可以是：

1. `BackgroundPhase`
2. `GridPhase`
3. `LogoPhase`
4. `CandlePhase`
5. `RightTextPhase`
6. `DatePhase`
7. `InfoTextPhase`
8. `MaxMinPhase`
9. `RealTimePricePhase`
10. `CrossLinePhase`
11. `OverlayPhase`

阶段顺序本质上就是视觉层级顺序，必须可读、可控、可调整。

最小调度骨架其实非常简单：

```dart
abstract class RenderPhase {
  bool shouldRender(RenderContext ctx) => true;
  void render(RenderContext ctx);
}

class RenderPipeline {
  final List<RenderPhase> phases;
  const RenderPipeline(this.phases);

  void execute(RenderContext ctx) {
    for (final phase in phases) {
      if (phase.shouldRender(ctx)) {
        phase.render(ctx);
      }
    }
  }
}
```

有了这层抽象后，很多“特殊条件”就不需要写在总入口里了。  
例如无数据时跳过 `CandlePhase`、长按关闭时跳过 `CrossLinePhase`，都能在 phase 内自行决定。

建议遵守一个顺序原则：

1. 先画静态底层（背景、网格）
2. 再画主体数据层（主图、副图）
3. 最后画交互与提示层（十字线、信息窗、overlay）

只要顺序稳定，图层关系就不会反复出 bug。

---

## 四、为什么阶段化方案更适合长期维护

传统写法容易变成：

- 一个 `paint()` 几百上千行
- 条件分支穿插
- 任意改动都可能影响全局绘制顺序

阶段化之后，收益通常体现在三点：

### 1) 可控的绘制职责

每个 phase 只做一件事，比如十字线、日期、实时价线互不污染。

### 2) 可扩展

新增能力（比如订单标记）可以通过 overlay 或新增 phase 扩展，不必侵入核心绘制路径。

### 3) 可测试与可定位

出现渲染 bug 时，可以快速定位是“哪一阶段”产生问题，而不是在巨型方法里盲查。

在工程里可以再加一个小技巧：  
给每个 phase 增加耗时采样，形成帧内“阶段耗时表”。

```dart
void executeWithProfile(RenderContext ctx) {
  for (final phase in phases) {
    final start = Timeline.now;
    if (phase.shouldRender(ctx)) phase.render(ctx);
    final cost = Timeline.now - start;
    logPhaseCost(phase.runtimeType.toString(), cost);
  }
}
```

这样掉帧时能快速定位到底是 `CandlePhase` 重，还是 `OverlayPhase` 重。

---

## 五、分时与蜡烛如何共存

主图渲染通过接口抽象（`BaseChartRenderer`）统一入口：

- K 线模式走 `CandleRenderer`
- 分时模式走 `TimeLineRenderer`

`TimeLineRenderer` 里还做了分时线的 path 与 fill 处理，并支持渐进绘制进度（`progress`）。  
这让“新增一根分时数据时的视觉过渡”可以独立控制，不影响蜡烛逻辑。

这里的关键是统一 renderer 接口，例如：

```dart
abstract class BaseChartRenderer<T> {
  void drawChart(T last, T cur, double lastX, double curX, Canvas canvas);
  void drawGrid(Canvas canvas, int rows, int columns);
  double y2price(double y);
}
```

只要接口保持稳定，主图从蜡烛切换到分时不会影响 phase 调度层。

---

## 六、落地优化方向

### 1) Phase 内缓存可复用对象

比如 TextPainter、Path、Paint 里可稳定复用的对象，尽量避免每帧新建。

### 2) 把高频变动和低频背景分层

网格/背景这类低频内容可考虑缓存层；  
十字线、实时价线这类高频内容保持动态层。

### 3) 扩展 phase 监控埋点

可以在 pipeline 执行中打每阶段耗时，快速知道瓶颈在哪个 phase。

### 4) 新增能力时遵循“一增一改”

比如你要新增“订单成本线”：

1. 新增一个 `OrderCostPhase`
2. 只在 `createPipeline()` 注册它

不要去改 `CandlePhase` 或 `CrossLinePhase` 的内部逻辑。  
这样新增能力是“局部增量”，不是“全局改写”。

---

## 总结

渲染层最值得坚持的原则是：  
先把坐标与可视区计算收敛，再把绘制行为阶段化。  
只要这条主线稳定，后续叠加订单、画线、提示框等能力时，复杂度就不会失控。
