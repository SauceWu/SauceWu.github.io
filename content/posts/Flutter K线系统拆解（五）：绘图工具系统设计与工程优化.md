---
date: 2025-07-21T13:35:00+09:00
tags: ["flutter", "kline", "drawing-tool", "interaction", "performance"]
title: "Flutter K线系统拆解（五）：绘图工具系统设计与工程优化"
---

# Flutter K线系统拆解（五）：绘图工具系统设计与工程优化

## 为什么要单独讲这一篇

K 线里的“画线工具”看起来是附属能力，但实现难度其实很高。  
它同时涉及：

- 绘图对象数据建模
- 点位命中与拖拽编辑
- 坐标与价格/时间映射
- 持久化与跨周期恢复
- 手势冲突与性能控制

如果这套系统没设计好，常见问题就是：点不中、拖不稳、误触多、数据丢、越画越卡。

---

## 一、先看系统分层（抽象视角）

一个完整的绘图工具系统，建议拆成 4 层：

1. 控制层：管理当前绘图对象集合、选中状态、缓存恢复、默认样式
2. 绘图对象层：定义线段/射线/矩形/圆/斐波那契等结构与完成条件
3. 渲染命中层：负责路径构建、绘制、命中测试、控制点渲染
4. 交互层：手势状态机（创建/编辑/移动/缩放）与工具面板联动

这类分层在交易类图表里经过大量实践验证，长期维护成本也更低。

---

## 二、绘图对象模型怎么设计更稳

### 1) 基础绘图对象字段

建议每个绘图对象至少包含：

- `pointList`：关键点集合（时间、价格）
- `type`：绘图对象类型
- `width` / `color`：样式
- `isSelected`：是否选中
- `isLock`：是否锁定编辑
- `tmpPoint`：未完成绘制时的临时点

这组字段可以覆盖“创建中”和“已完成”两种生命周期。

### 2) “完成条件”必须放在绘图对象内部

不同绘图对象点数不同：

- 圆、线段、矩形、斐波那契：2 点完成
- 三角形：3 点完成
- 特殊线（水平线/价格线）：1 点可完成
- 波浪线：可能需要 4 点或 6 点

把 `checkLength()` 放在绘图对象内部，而不是写在手势层的 `if/else` 里，后续扩展新绘图对象时成本最低。

---

## 三、命中与编辑：这是最容易踩坑的区域

### 1) 闭合图形 vs 非闭合路径

命中策略应区分：

- 闭合图形（圆、矩形、三角形）：可用 path contains
- 非闭合线（射线、趋势线）：要做“路径附近容差命中”

线类通常要按路径采样，计算点击点与路径点距离是否小于阈值（如 20px）。

### 2) 控制点优先于图形体

编辑时建议命中优先级：

1. 控制点命中（单点拖拽）
2. 图形体命中（整体平移）
3. 空白区域（取消选中/透传手势）

这样用户感知最符合预期，不会出现“想拖端点却总是拖动整条线”。

### 3) 锁定态要全链路生效

`isLock` 不能只影响 UI 按钮，还要在交互路径上硬拦截：

- 禁止控制点拖动
- 禁止整体移动
- 禁止样式修改

否则视觉上“锁了”，行为上还能改，会非常混乱。

---

## 四、坐标映射是精度核心

绘图工具本质上不是保存像素，而是保存“业务坐标”：

- X 轴保存时间索引/时间戳
- Y 轴保存价格值

编辑时流程应该是：

1. 手势拿到本地像素坐标
2. 像素 -> 时间/价格
3. 写回绘图对象数据
4. 渲染时再由时间/价格 -> 屏幕坐标

这样即使缩放、滚动、切周期，绘图对象也能稳定跟随数据，不会“漂移”。

---

## 五、持久化设计：别只存样式，必须存语义点

正确缓存单位应该是绘图对象 JSON（点位 + 类型 +样式 + 锁定状态），而不是屏幕点。  
并且缓存 key 最好绑定：

- 交易对（symbol）
- 周期（resolution）

这样切市场、切周期时能独立恢复，不会串线。

---

## 六、交互状态机建议（实战版）

建议把状态显式化，而不是散在多个布尔值里。这样做的核心收益是：状态转移路径更清晰、异常分支更少、回归测试更容易覆盖。

- `idle`：无选中
- `creating`：新建绘图对象中（未满足点数）
- `selected`：选中已完成绘图对象
- `dragPoint`：拖拽控制点
- `dragShape`：整体平移
- `scalingChart`：双指缩放图表

进一步的工程化方向是收敛成枚举状态机，把状态迁移写成明确规则，持续降低交互分支复杂度。

---

## 七、性能优化清单（画线系统专项）

### 1) 命中测试降频

拖动过程每帧做全量绘图对象命中会重。  
建议只在手势开始时做一次命中定位，后续直接操作命中的那个对象。

### 2) 文本测量缓存

像斐波那契每条线都带文本，频繁创建文本布局对象会有开销。  
可按“价格未变化不重建文本”做缓存。

### 3) 工具面板与图表重绘隔离

浮动工具条建议独立状态，避免改颜色/线宽时触发整张图重绘。

### 4) 选中态才绘制控制点

控制点属于高频装饰层，只在选中态绘制即可，能明显减少常态渲染负担。

---

## 八、最常见的 5 个线上问题与对应修法

### 1) 点击总是选不中线

症状：细线在高分屏上很难点中。  
修法：线类命中使用“路径附近容差”，并按设备像素比放大。

```dart
bool hitTestLine(Path path, Offset point, BuildContext context) {
  final dpr = MediaQuery.of(context).devicePixelRatio;
  final tolerance = (12.0 * dpr).clamp(12.0, 28.0); // 按 DPI 自适应

  for (final metric in path.computeMetrics()) {
    for (double d = 0; d <= metric.length; d += 6) {
      final p = metric.getTangentForOffset(d)?.position;
      if (p != null && (p - point).distance <= tolerance) return true;
    }
  }
  return false;
}
```

### 2) 拖动端点时整条线在动

症状：用户本来想拖控制点，结果整条线被平移。  
修法：命中优先级固定为“控制点 > 图形体”。

```dart
enum HitType { point, shape, none }

HitType hitTest(Offset p, List<Offset> controlPoints, Path shapePath) {
  for (final cp in controlPoints) {
    if ((cp - p).distance <= 20) return HitType.point;
  }
  if (shapePath.contains(p)) return HitType.shape;
  return HitType.none;
}

void onPanUpdate(Offset p) {
  switch (_hitType) {
    case HitType.point:
      moveControlPoint(p);
      break;
    case HitType.shape:
      moveWholeShape(p);
      break;
    case HitType.none:
      break;
  }
}
```

### 3) 切周期后绘图对象错位

症状：切 `1m/5m/1h` 后线段漂移。  
修法：持久化业务坐标（time/price），绘制时再映射到像素。

```dart
class DrawPoint {
  final int time;      // 业务坐标
  final double price;  // 业务坐标
  DrawPoint(this.time, this.price);
}

// 保存：存 time/price，不存 x/y
final cache = points.map((e) => {'time': e.time, 'price': e.price}).toList();

// 绘制：实时映射
Offset toScreen(DrawPoint p) => Offset(getXByTime(p.time), getYByPrice(p.price));
```

### 4) 锁定后还能改线

症状：UI 显示已锁定，但手势仍能移动或改样式。  
修法：在交互入口统一拦截，UI 和行为双锁。

```dart
void onPanStart(Offset p) {
  if (selectedShape?.isLock == true) return; // 行为锁
  startDrag(p);
}

void onChangeColor(Color c) {
  if (selectedShape?.isLock == true) return; // 样式锁
  selectedShape!.color = c;
}

Widget buildLockButton() {
  final locked = selectedShape?.isLock ?? false;
  return Icon(locked ? Icons.lock : Icons.lock_open);
}
```

### 5) 画线多了明显掉帧

症状：对象变多后，拖动时明显卡顿。  
修法：命中降频 + 文本缓存 + 仅选中态绘制控制点。

```dart
KLineDrawer? _active; // 手势开始时锁定目标
final Map<String, TextPainter> _labelCache = {};

void onPanStart(Offset p) {
  _active = hitTestOnce(p); // 不在 onPanUpdate 全量命中
}

void drawShape(Canvas c, Shape s) {
  // 仅选中态绘制控制点
  if (s.isSelected) drawControlPoints(c, s);

  // 文本缓存（例如 fibonacci 标签）
  final key = '${s.id}_${s.lastPrice}';
  final tp = _labelCache.putIfAbsent(key, () => buildTextPainter(s.label));
  tp.paint(c, s.labelOffset);
}
```

---

## 总结

绘图工具系统不是“在 K 线上再画几条 path”这么简单，它本质上是一个独立子系统。  
当模型、命中、映射、状态机、持久化这五个环节都被系统化后，新增工具类型和交互能力就会稳定很多。
