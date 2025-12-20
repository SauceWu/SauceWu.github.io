---
date: 2025-12-20T16:00:00-00:00
tags: ["flutter", "go-router", "router", "statefulshellroute", "dialog"]
title: "StatefulShellRoute 踩坑：为什么 Loading 只遮半屏，pop 还会误关页面"
---

# StatefulShellRoute 踩坑：为什么 Loading 只遮半屏，pop 还会误关页面

## 目录

- 一、问题现象
- 二、根因不是 Dialog，而是 Navigator 变多了
- 三、为什么只遮住半屏
- 四、为什么 pop 之后页面被关了
- 五、正确做法：全局浮层挂到 root navigator
- 六、一个更稳的封装思路
- 七、总结

## 一、问题现象

我在用 `go_router + StatefulShellRoute` 做多 Tab 导航时，遇到了一个很烦的坑：

- `showDialog` 弹出来的 loading 只遮住了一半屏幕
- 我如果用全局 `context` 去 `pop()`，结果关掉的不是 loading，而是整个页面

第一次碰到这个问题时会很懵，因为从表面看：

- loading 明明弹出来了
- `pop` 也确实执行了

但行为就是不对。

后来我才意识到，这不是 `showDialog` 本身的问题，而是 **`StatefulShellRoute` 下导航栈已经不是单层结构了**。

## 二、根因不是 Dialog，而是 Navigator 变多了

在普通单栈应用里，我们通常默认只有一个 `Navigator`。  
这时候很多写法都没问题：

```dart
showDialog(
  context: context,
  builder: (_) => const LoadingDialog(),
);

Navigator.of(context).pop();
```

因为“打开弹窗”和“关闭弹窗”通常都发生在同一个 navigator 上。

但 `StatefulShellRoute` 不一样。

它的典型场景是：

- 底部有多个 Tab
- 每个 Tab 各自维护独立导航栈
- 外层还有一个 root navigator

也就是说，此时应用里很可能同时存在：

- root navigator
- branch A navigator
- branch B navigator
- branch C navigator

一旦你没有明确指定 dialog 挂在哪个 navigator 上，或者 `pop` 时没有明确指定要操作哪个 navigator，就很容易出现“打开在 A，关闭却关了 B”的错位问题。

## 三、为什么只遮住半屏

这个现象的本质是：

**你的 dialog 很可能是挂在某个 branch navigator 上，而不是最外层的 root navigator 上。**

在 `StatefulShellRoute` 结构里，一个 branch navigator 往往只负责壳层中的某一块内容区域。  
比如底部导航栏还在外层 scaffold 里，而当前 tab 内容在内层 navigator 中。

如果这时候 dialog 是加在 branch navigator 上，它覆盖的就只是这一层的内容区域，而不是整个屏幕。

于是你看到的现象就是：

- loading 出现了
- 但没有全屏遮罩
- 底部栏或者外层区域依然露在外面

这不是弹窗尺寸错了，而是**挂载层级错了**。

## 四、为什么 pop 之后页面被关了

这也是同一个问题的另一面。

很多人习惯在 `go_router` 里直接这样写：

```dart
context.pop();
```

或者：

```dart
Navigator.of(context).pop();
```

在单一 navigator 结构里，这通常没问题。  
但在 `StatefulShellRoute` 下，这个 `context` 属于谁，并不总是你以为的那个 navigator。

如果：

- loading 是挂在 root navigator 上
- 你却在 branch navigator 上调用了 `pop`

那么 branch navigator 会认为：“你是要返回当前页面”。  
结果就变成了：

- loading 没关
- 当前页面反而被 pop 掉了

反过来也一样：

- loading 挂在 branch navigator 上
- 你拿 root navigator 去关

也可能出现行为错乱。

所以这类问题的核心不是 `pop` 失效，而是：

**你并没有明确告诉 Flutter：你到底想关闭哪一个 navigator 上的 route。**

## 五、正确做法：全局浮层挂到 root navigator

如果你的目标是：

- 全屏 loading
- 全局确认弹窗
- 全局错误提示
- 不依赖某个 tab 局部区域

那最稳的做法就是：

**统一挂到 root navigator。**

例如先定义好根导航 key：

```dart
final rootNavigatorKey = GlobalKey<NavigatorState>();
final homeNavigatorKey = GlobalKey<NavigatorState>();
final profileNavigatorKey = GlobalKey<NavigatorState>();
```

```dart
final router = GoRouter(
  navigatorKey: rootNavigatorKey,
  routes: [
    StatefulShellRoute.indexedStack(
      branches: [
        StatefulShellBranch(
          navigatorKey: homeNavigatorKey,
          routes: [
            GoRoute(
              path: '/home',
              builder: (context, state) => const HomePage(),
            ),
          ],
        ),
        StatefulShellBranch(
          navigatorKey: profileNavigatorKey,
          routes: [
            GoRoute(
              path: '/profile',
              builder: (context, state) => const ProfilePage(),
            ),
          ],
        ),
      ],
      builder: (context, state, navigationShell) {
        return MainScaffold(shell: navigationShell);
      },
    ),
  ],
);
```

显示 loading 时，明确走 root navigator：

```dart
showDialog(
  context: rootNavigatorKey.currentContext!,
  barrierDismissible: false,
  useRootNavigator: true,
  builder: (_) => const Center(
    child: CircularProgressIndicator(),
  ),
);
```

关闭时也明确操作 root navigator：

```dart
rootNavigatorKey.currentState?.pop();
```

或者：

```dart
Navigator.of(
  rootNavigatorKey.currentContext!,
  rootNavigator: true,
).pop();
```

这样至少能保证两件事：

- loading 是全屏覆盖
- 关闭时不会误伤当前页面路由

## 六、一个更稳的封装思路

这里还有一个很现实的问题。

如果每次都要在页面里自己 new 一个 loading helper，那这个方案还是太别扭了。  
在大多数项目里，`loading dialog` 本来就应该是**应用级单例能力**，而不是页面级临时对象。

真正适合大项目的做法通常是：

- app 启动时就持有 `rootNavigatorKey`
- 全局注册一个 `LoadingService`
- 所有页面都只调同一个 `show/hide`

这样才能保证：

- 全局行为一致
- 不会每个页面都重复处理 navigator 细节
- 不会因为某个页面传错 context 又踩一遍坑

例如可以直接封装成单例服务：

```dart
class AppLoadingService {
  AppLoadingService._();

  static final AppLoadingService instance = AppLoadingService._();

  GlobalKey<NavigatorState>? _rootNavigatorKey;
  bool _showing = false;

  void bindRootNavigator(GlobalKey<NavigatorState> key) {
    _rootNavigatorKey = key;
  }

  Future<void> show() async {
    if (_showing) return;

    final context = _rootNavigatorKey?.currentContext;
    if (context == null) return;

    _showing = true;

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      useRootNavigator: true,
      builder: (_) => const PopScope(
        canPop: false,
        child: Center(
          child: CircularProgressIndicator(),
        ),
      ),
    );

    _showing = false;
  }

  void hide() {
    if (!_showing) return;
    _rootNavigatorKey?.currentState?.pop();
  }
}
```

在路由初始化后绑定 root navigator：

```dart
final rootNavigatorKey = GlobalKey<NavigatorState>();

void setupLoading() {
  AppLoadingService.instance.bindRootNavigator(rootNavigatorKey);
}
```

业务层只需要：

```dart
AppLoadingService.instance.show();
AppLoadingService.instance.hide();
```

如果你项目里已经用了 `GetIt`、`Provider` 或别的 DI 容器，也完全可以把它注册成全局单例服务，本质都一样。

关键不是用什么容器，而是这条规则：

**全局 loading 必须只有一个出口，并且这个出口只操作 root navigator。**

这样收口之后，`StatefulShellRoute` 下的 loading 才会真正稳定。  
否则就算今天这个页面修好了，明天别的同事在另一个 tab 页面里再写一遍 `showDialog(context: context)`，同样的问题还会回来。

## 七、再进一步：单例还不够，并发也要处理

把 loading 做成单例之后，问题其实还没有完全结束。

在真实项目里，经常会遇到这种情况：

- 页面初始化时发一个请求
- 用户点击按钮又发一个请求
- 两个请求几乎同时开始

如果你的 loading 只有简单的 `show()` 和 `hide()`，就会出现新的问题：

1. 请求 A `show`
2. 请求 B `show`
3. 请求 A 先结束，调用 `hide`
4. loading 被关掉了
5. 但请求 B 其实还没结束

这时候用户看到的就是：

- 页面还在忙
- loading 却提前消失了

所以更稳的做法通常不是“布尔值 showing”，而是**引用计数**。

例如：

```dart
class AppLoadingService {
  AppLoadingService._();

  static final AppLoadingService instance = AppLoadingService._();

  GlobalKey<NavigatorState>? _rootNavigatorKey;
  int _count = 0;
  bool _visible = false;

  void bindRootNavigator(GlobalKey<NavigatorState> key) {
    _rootNavigatorKey = key;
  }

  void show() {
    _count++;
    if (_visible) return;

    final context = _rootNavigatorKey?.currentContext;
    if (context == null) {
      _count = 0;
      return;
    }

    _visible = true;

    showDialog<void>(
      context: context,
      barrierDismissible: false,
      useRootNavigator: true,
      builder: (_) => const PopScope(
        canPop: false,
        child: Center(
          child: CircularProgressIndicator(),
        ),
      ),
    ).then((_) {
      _visible = false;
    });
  }

  void hide() {
    if (_count <= 0) return;

    _count--;
    if (_count > 0) return;
    if (!_visible) return;

    _rootNavigatorKey?.currentState?.pop();
  }
}
```

这个版本的含义是：

- 每来一个任务就 `show()`
- 每结束一个任务就 `hide()`
- 只有当计数归零时，loading 才真正关闭

对于接口多、并发多的大项目，这种处理会稳很多。

当然，它也不是银弹。  
如果项目里有人忘记调用 `hide()`，或者异常分支没收口，loading 还是可能挂住。  
所以比较好的实践通常是：

- 在请求拦截层统一收口
- 或者至少用 `try/finally` 保证 `hide()` 一定执行

例如：

```dart
Future<T> runWithLoading<T>(Future<T> Function() task) async {
  AppLoadingService.instance.show();
  try {
    return await task();
  } finally {
    AppLoadingService.instance.hide();
  }
}
```

这样业务层就不用自己到处配对写 `show/hide` 了。

如果只是偶尔手动控制，也建议统一走单例：

```dart
AppLoadingService.instance.show();
AppLoadingService.instance.hide();
```

但从工程实践上看，**更推荐把 `runWithLoading` 作为默认入口**，因为它天然能保证 `show/hide` 成对出现。

## 八、什么时候该考虑 OverlayEntry

如果项目只是偶尔弹一个 loading，`showDialog` 完全够用。  
但如果你的项目已经比较大，loading 使用非常频繁，很多团队最后会继续往前走一步，改成 `OverlayEntry` 方案。

原因通常不是因为 `showDialog` 不能用，而是因为 `OverlayEntry` 更适合做“应用级全局浮层”：

- 不走页面路由栈
- 不需要额外 `pop`
- 更适合做全局遮罩、toast、loading 这类 UI
- 对复杂路由结构更友好

可以简单理解成：

- `showDialog` 更像“弹一个模态 route”
- `OverlayEntry` 更像“往最上层插一个浮层”

在 `StatefulShellRoute` 这种多 navigator 结构里，后者往往更符合 loading 的定位。

不过从文章这个问题出发，最重要的仍然不是立刻换成 `OverlayEntry`，而是先建立正确原则：

- 全局 loading 统一收口
- 只挂 root 层
- 不混用页面 pop 和弹窗 pop

把这三件事先做好，已经能解决大多数坑。

## 九、总结

`StatefulShellRoute` 最容易让人踩坑的地方，不是 API 难懂，而是它让“应用里只有一个 Navigator”这个默认前提失效了。

所以当你遇到下面这些现象时：

- dialog 只遮住局部区域
- `pop` 误关当前页面
- 不同 tab 下弹窗行为不一致

大概率都该先怀疑一件事：

**你当前打开和关闭弹窗时，操作的并不是同一个 navigator。**

对于全局 loading 这类浮层，一个很实用的经验就是：

- **显示时挂 root navigator**
- **关闭时也只操作 root navigator**
- **不要混用页面路由 pop 和弹窗 pop**

把这条规则立住之后，`StatefulShellRoute` 下大部分弹窗错位问题都会清爽很多。
