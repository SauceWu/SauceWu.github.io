---
date: 2025-04-07T13:15:00+09:00
tags: ["flutter", "kline", "gesture", "animation", "performance"]
title: "Flutter K线系统拆解（四）：交互体系与性能工程"
---

# Flutter K线系统拆解（四）：交互体系与性能工程

## 为什么交互比指标更容易暴露问题

很多交易页在功能上都能“跑起来”，但只要用户开始频繁缩放、拖动、长按，体验差异会立刻被放大。  
体感里的“丝滑”和“卡顿”，通常不来自单一 bug，而是交互链路里多个小问题叠加：

- 手势事件触发过密
- 状态更新范围过大
- 动画和计算抢同一帧预算
- 非关键绘制在高频交互里持续执行

所以这一篇的重点不是“某个技巧”，而是如何把交互链路做成一套稳定的工程系统。

---

## 一、交互设计里的三个关键决定

### 1) 方向锁定：先判断用户意图，再决定谁接管手势

在图表可编辑、页面又可滚动的场景里，方向锁是刚需。  
当手势轨迹偏垂直时，把事件交给外层滚动容器；偏水平时再由图表处理，这能明显减少“手势打架”。

方向锁不是锦上添花，而是复杂页面里“能不能用”的分水岭。

### 2) 状态分离：长按、拖拽、缩放不要混成一个开关

把 `isLongPress`、`isDrag`、`isScale` 独立维护，收益很直接：  
状态更可控、回归更容易、边界问题更少。  
尤其在十字线与拖拽共存时，状态分离可以显著降低互相干扰。

### 3) 绘制隔离：高频区域和低频区域分开

给图表主体加 `RepaintBoundary`，本质是在缩小重绘传播范围。  
在包含导航栏、侧边信息、浮层工具条的复杂页面里，这个动作通常会带来稳定的帧率收益。

---

## 二、为什么动画控制需要集中管理

把动画控制器收敛到 `KlineAnimationManager` 这类单点管理器，有两个长期价值：

1. 生命周期统一：创建、监听、销毁都在一处，避免泄漏与重复监听
2. 行为统一：惯性滚动、回到最新点、闪烁动画等交互逻辑不再散落在页面状态里

常见的几类动画职责可以明确分工：

- `shiningController`：实时价闪烁反馈
- `moveController`：惯性滚动与回弹
- `updateController`：新数据推进动画
- `marginController`：扩展模式动画

这样拆完后，手势层只输出“输入”，动画层负责“运动学”，结构会清晰很多。

---

## 三、为什么有时顺、有时卡

真实线上卡顿大多是“组合拳”：

- 高频手势触发频繁重建
- 数据推送和渲染挤在同一帧
- 十字线信息窗更新范围过大
- 可见区裁剪不充分导致额外绘制

即便已经做了可见区索引裁剪，在高频行情阶段也依然可能抖动。  
原因不是“裁剪没用”，而是它只解决了其中一部分问题，剩下还要靠更新节流和分层降级。

---

## 四、生产里最实用的优化策略

### 1) 行情更新按帧合并

问题本质是：推送频率通常高于屏幕刷新频率。  
如果每个 tick 都触发一次 `setState`，UI 线程会被大量“看不见的重复刷新”占满。

推荐做法是把短时间窗口内的更新批量合并，只在下一帧统一提交：

```dart
class FrameMergeUpdater {
  final List<Tick> _buffer = [];
  bool _scheduled = false;

  void onTick(Tick tick, VoidCallback flush) {
    _buffer.add(tick);
    if (_scheduled) return;
    _scheduled = true;

    SchedulerBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      // 合并同一时间片数据，只保留最终状态
      final merged = mergeTicks(_buffer);
      _buffer.clear();
      applyMergedData(merged);
      flush(); // 统一刷新一次
    });
  }
}
```

### 2) 交互期动态降级

用户快速拖动/缩放时，最怕“每一帧都画满全部细节”。  
这时候应该优先保障手势响应和主图连续性，把次要内容延后补画。

可以用“交互态开关”实现：

```dart
bool isInteracting = false;

void onScaleStart(_) => isInteracting = true;
void onScaleEnd(_) {
  isInteracting = false;
  notifyChanged(); // 交互结束后补齐细节
}

void drawOverlay(Canvas canvas) {
  if (isInteracting) return; // 交互中先不画复杂 overlay
  drawComplexTags(canvas);
  drawExtraDecorations(canvas);
}
```

建议优先降级这些内容：

- 复杂文本标签
- 非关键装饰线
- 次级 overlay（不影响交易决策）

### 3) 十字线信息局部刷新

十字线联动通常是高频事件，如果直接触发整页 build，很容易出现“拖十字线时页面发颤”。

更稳的方式是把十字线信息单独做成轻量状态通道：

```dart
final ValueNotifier<CrosshairInfo?> crosshairInfo = ValueNotifier(null);

void onCrosshairMove(CrosshairInfo info) {
  crosshairInfo.value = info; // 只更新信息窗
}

Widget buildInfoPanel() {
  return ValueListenableBuilder<CrosshairInfo?>(
    valueListenable: crosshairInfo,
    builder: (_, info, __) => InfoPanel(info: info),
  );
}
```

### 4) 计算与渲染解耦

指标全量计算、复杂统计都应该尽量从 UI 线程剥离。  
UI 线程只处理“输入响应 + 最终渲染”，否则手势响应会被计算任务抢占。

```dart
Future<List<KLineEntity>> recalcInBackground(List<KLineEntity> data) async {
  return compute(runFullIndicatorCalc, data); // isolate
}

void onParamsChanged() async {
  final snapshot = await recalcInBackground(currentData);
  setState(() {
    currentData = snapshot; // 一次性替换快照
  });
}
```

实践建议：

- 增量更新留在主线程（轻量）
- 全量重算放 isolate（重量）
- 回传快照时一次性提交，避免碎片化更新

### 5) 以数据验证优化，而不是靠感觉

DevTools 至少盯三项，并分别判断瓶颈归因：

- Raster 是否超预算
- UI 线程 build/layout 峰值
- 交互期间对象分配和 GC 尖峰

一个简单的排查顺序：

1. UI thread 高：优先查重建范围和计算是否跑在主线程
2. Raster 高：优先查绘制内容是否过重、是否缺少分层与缓存
3. GC 尖峰高：优先查高频路径里对象创建（TextPainter/Path/List）

只有量化数据才能判断“是算法慢、渲染慢，还是状态管理导致的重建过多”。

---

## 五、交易页的落地建议：双模式运行

这个“双模式”可以理解成一句话：

手在屏幕上动的时候，先保流畅；手停下来以后，再补细节。

### 1) 两个模式分别做什么

`交互优先模式`（手势进行中）：

- 只保留主图绘制（K 线/分时主线）
- 暂停复杂标签、次级 overlay、重文本绘制
- 十字线信息只做最小更新
- 禁止触发全量指标重算

`信息优先模式`（手势结束后）：

- 恢复完整标签与 overlay
- 补齐信息窗、订单标记、辅助元素
- 必要时再做一次轻量校准刷新

### 2) 什么时候切换模式

建议切换规则非常直接：

- `onScaleStart/onPanStart` -> 进入交互优先模式
- `onScaleEnd/onPanEnd` -> 延迟 80~150ms 后切回信息优先模式

为什么要加一个短延迟：  
避免用户连续手势时频繁来回切换模式，造成视觉抖动。

### 3) 一个可直接套用的代码骨架

```dart
enum RenderMode { interactive, full }

class KlineRenderModeController {
  RenderMode mode = RenderMode.full;
  Timer? _restoreTimer;

  void onGestureStart(VoidCallback refresh) {
    _restoreTimer?.cancel();
    if (mode != RenderMode.interactive) {
      mode = RenderMode.interactive;
      refresh();
    }
  }

  void onGestureEnd(VoidCallback refresh) {
    _restoreTimer?.cancel();
    _restoreTimer = Timer(const Duration(milliseconds: 120), () {
      mode = RenderMode.full;
      refresh();
    });
  }
}
```

在绘制阶段按模式开关能力：

```dart
void drawOverlay(Canvas canvas, RenderMode mode) {
  if (mode == RenderMode.interactive) {
    drawEssentialCrosshair(canvas); // 仅关键信息
    return;
  }
  drawEssentialCrosshair(canvas);
  drawOrderMarks(canvas);
  drawComplexTags(canvas);
  drawExtraOverlays(canvas);
}
```

### 4) 这套方案的验收标准

上线前可以用三个可观察标准判断是否生效：

1. 连续缩放/拖动时，手感明显更跟手，不再“拖不动”
2. 手势结束后 0.2 秒内，细节完整恢复
3. DevTools 中交互期 UI/Raster 峰值明显下降

---

## 总结

交互性能不是一个参数能调好的问题，而是一整条链路的工程协同。  
方向锁、状态分离、动画集中管理、按帧合并更新、交互期动态降级，这几件事做扎实之后，K 线在高频操作下会明显更稳、更顺。
