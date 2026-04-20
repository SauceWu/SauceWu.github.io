---
date: 2026-04-20T12:00:00-00:00
tags: ["flutter", "performance", "optimization"]
title: "Flutter 性能优化实战"
---

# Flutter 性能优化实战

## 目录

- 一、性能问题的三个来源
- 二、Build 阶段优化
- 三、Layout / Paint 阶段优化
- 四、内存与图片优化
- 五、列表性能
- 六、用 DevTools 定位问题
- 七、速查清单

---

## 一、性能问题的三个来源

Flutter 渲染一帧的流程是：**Build → Layout → Paint → Composite → Rasterize**。性能问题几乎都出在前三个阶段：

| 阶段 | 常见症状 | 核心指标 |
|------|---------|---------|
| Build | UI 卡顿、帧率下降 | Widget rebuild 次数过多 |
| Layout / Paint | 滚动掉帧 | 标脏范围过大 |
| 内存 | OOM、图片闪烁 | 内存持续增长不释放 |

Flutter 的目标帧率是 **60fps（16ms/帧）** 或 **120fps（8ms/帧）**，超过预算就会掉帧（jank）。

---

## 二、Build 阶段优化

Build 阶段是最常见的性能坑，核心问题只有一个：**不该重建的 Widget 被重建了**。

### 2.1 缩小 setState 的影响范围

`setState` 会触发当前 StatefulWidget 的整棵子树 rebuild。如果你把状态放在顶层，一次变化就可能重建整个页面。

**反例：**

```dart
// ❌ 整个 Page 都会 rebuild
class PageState extends State<Page> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        HeavyWidget(),      // 每次 count 变化都重建，完全没必要
        Text('$count'),
        ElevatedButton(onPressed: () => setState(() => count++), child: Text('+'))
      ],
    );
  }
}
```

**正例：把状态下沉到最小范围**

```dart
// ✅ 只有 Counter 自己 rebuild
class Page extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        HeavyWidget(),   // 永远不会因为 count 变化而重建
        Counter(),
      ],
    );
  }
}

class Counter extends StatefulWidget { ... }
```

### 2.2 const Widget

标记 `const` 的 Widget，Flutter 会在编译期复用同一个实例，Element diff 时直接跳过，不进入 rebuild 流程。

```dart
// ✅ 编译期常量，不参与 diff
const Text('标题')
const SizedBox(height: 16)
const Icon(Icons.home)
```

**经验：** 开启 `flutter analyze` 的 `prefer_const_constructors` lint，编辑器会自动提示哪里能加 `const`。

### 2.3 拆分 Widget 而不是用方法

用方法（`_buildXxx()`）返回 Widget 看起来能减少代码，但它只是在父 Widget 的 `build` 里内联展开，父 Widget rebuild 时方法一定被调用。

```dart
// ❌ _buildHeader 每次都执行
Widget build(BuildContext context) {
  return Column(children: [_buildHeader(), _buildBody()]);
}

// ✅ Header 是独立 Widget，可以被 diff 复用
Widget build(BuildContext context) {
  return Column(children: [Header(), Body()]);
}
```

### 2.4 使用 RepaintBoundary 隔离动画

频繁重绘的区域（动画、计时器、粒子效果）会把重绘"传染"给周围的静态内容。用 `RepaintBoundary` 把它隔离在独立 Layer：

```dart
RepaintBoundary(
  child: Lottie.asset('animation.json'),
)
```

底层会创建独立的 `OffsetLayer`，GPU 合成时直接复用缓存纹理，不触发周围内容重绘。

---

## 三、Layout / Paint 阶段优化

### 3.1 避免 Opacity 动画直接驱动 Widget

`Opacity` Widget 每帧都会触发 paint，哪怕内容没变。改用 `AnimatedOpacity` 或直接操作 `FadeTransition`——它们走 Composite 阶段，不触发 paint。

```dart
// ❌ 每帧都 paint
Opacity(opacity: _animation.value, child: MyWidget())

// ✅ 只走 composite，不 paint
FadeTransition(opacity: _animation, child: MyWidget())
```

同理：`Transform` 和 `ClipRect` 有对应的 `*Transition` 版本，能用就用 Transition。

### 3.2 避免在 build 里做耗时计算

`build` 方法每帧可能多次调用，不要在里面做排序、过滤、JSON 解析等操作：

```dart
// ❌ 每次 rebuild 都排序
Widget build(BuildContext context) {
  final sorted = items.sorted((a, b) => a.date.compareTo(b.date)); // 危险
  return ListView(...);
}

// ✅ 在 initState 或数据更新时计算一次，缓存结果
List<Item> _sorted = [];

@override
void initState() {
  super.initState();
  _sorted = [...widget.items]..sort((a, b) => a.date.compareTo(b.date));
}
```

### 3.3 ClipRRect 的代价

`ClipRRect` 会强制 Flutter 创建新的 Layer 并用 saveLayer 做离屏渲染，代价较高。如果只是圆角卡片，优先用 `BoxDecoration` + `borderRadius`，不触发离屏渲染：

```dart
// ❌ 触发 saveLayer
ClipRRect(
  borderRadius: BorderRadius.circular(12),
  child: Image.network(url),
)

// ✅ 不触发 saveLayer
Container(
  decoration: BoxDecoration(
    borderRadius: BorderRadius.circular(12),
    image: DecorationImage(image: NetworkImage(url), fit: BoxFit.cover),
  ),
)
```

---

## 四、内存与图片优化

### 4.1 图片尺寸匹配显示尺寸

Flutter 会按图片原始分辨率解码再缩放。一张 4000×3000 的图显示在 100×100 的头像里，会白白占用大量内存。

```dart
// ✅ 指定 cacheWidth/cacheHeight，按显示尺寸解码
Image.network(
  url,
  cacheWidth: 200,   // 逻辑像素 × devicePixelRatio
  cacheHeight: 200,
)
```

### 4.2 及时释放 AnimationController

`AnimationController` 持有 `TickerProvider`，忘记 dispose 会造成内存泄漏和后台帧回调：

```dart
@override
void dispose() {
  _controller.dispose(); // 必须
  super.dispose();
}
```

### 4.3 谨慎使用 saveLayer

以下操作会隐式触发 `saveLayer`（离屏渲染），在低端机上很容易成为性能瓶颈：

- `ShaderMask`
- `ColorFilter`
- `BackdropFilter`（高斯模糊）
- `Opacity` 值在 0~1 之间且子树复杂

能用 `DecoratedBox`、`ColoredBox` 代替的场景，不要用 `Opacity`。

---

## 五、列表性能

### 5.1 用 ListView.builder 而非 ListView

```dart
// ❌ 一次性创建所有子 Widget
ListView(children: items.map((e) => ItemWidget(e)).toList())

// ✅ 懒加载，只创建可见区域的 Widget
ListView.builder(
  itemCount: items.length,
  itemBuilder: (context, index) => ItemWidget(items[index]),
)
```

### 5.2 给列表项加 Key

列表数据顺序变化（排序、删除）时，不加 Key 会导致 Flutter 用错 Element，出现状态错位：

```dart
ListView.builder(
  itemBuilder: (context, index) => ItemWidget(
    key: ValueKey(items[index].id),  // 用业务 id 作为 key
    item: items[index],
  ),
)
```

### 5.3 itemExtent 或 prototypeItem

如果列表项高度固定，声明 `itemExtent` 可以让 Flutter 跳过 layout 计算，直接定位滚动位置：

```dart
ListView.builder(
  itemExtent: 72.0,   // 固定高度，layout 性能提升明显
  itemBuilder: (_, i) => ListTile(...),
)
```

---

## 六、用 DevTools 定位问题

### 6.1 Performance 面板

运行 `flutter run --profile` 后打开 DevTools → Performance，查看：

- **UI 线程**：耗时集中在 build/layout/paint 哪个阶段
- **Raster 线程**：耗时高说明有 saveLayer 或大纹理

帧条颜色：绿色正常，黄色轻微超预算，红色掉帧。

### 6.2 Widget Rebuild 统计

在 DevTools → Performance → 勾选 **Track widget rebuilds**，可以看到每一帧中每个 Widget 的 rebuild 次数，精准定位哪个 Widget 被过度重建。

### 6.3 flutter_hooks 或 riverpod 的 select

使用状态管理时，用 `select` 只订阅用到的字段，避免无关字段变化触发 rebuild：

```dart
// ❌ user 的任何字段变化都触发 rebuild
final user = ref.watch(userProvider);

// ✅ 只有 name 变化才 rebuild
final name = ref.watch(userProvider.select((u) => u.name));
```

---

## 七、速查清单

| 问题 | 解法 |
|------|------|
| 整页 rebuild | 状态下沉，缩小 StatefulWidget 范围 |
| 静态 Widget 频繁重建 | 加 `const` |
| 动画带动周围内容重绘 | `RepaintBoundary` |
| Opacity 动画卡 | 换 `FadeTransition` |
| 图片内存占用高 | 指定 `cacheWidth` / `cacheHeight` |
| 圆角图片卡 | 用 `BoxDecoration` 替代 `ClipRRect` |
| 长列表卡 | `ListView.builder` + `itemExtent` |
| 列表状态错乱 | 加 `ValueKey` |
| 找不到卡顿原因 | `flutter run --profile` + DevTools |
| 状态管理过度 rebuild | `select` 精确订阅 |
