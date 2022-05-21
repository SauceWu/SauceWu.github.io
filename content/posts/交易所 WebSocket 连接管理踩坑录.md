---
date: 2022-05-21T10:00:00+09:00
tags: ["flutter", "websocket", "trading", "exchange", "realtime"]
title: "交易所 WebSocket 连接管理踩坑录"
---

# 交易所 WebSocket 连接管理踩坑录

交易所 App 对实时连接的依赖极高，行情、深度、订单状态全靠 WebSocket 推送，连接一断用户就处于盲区。从基础到深度整理踩过的坑。

---

## 一、重连与指数退避

裸写的 `WebSocket.connect` 断了就断了，没有自愈能力：

```dart
Future<void> connect(String url) async {
  while (!_disposed && _retryCount < _maxRetries) {
    try {
      _socket = await WebSocket.connect(url);
      _retryCount = 0;
      await _socket!.listen(
        onData: _onMessage,
        onDone: () => _scheduleReconnect(url),
        onError: (_) => _scheduleReconnect(url),
        cancelOnError: true,
      ).asFuture();
    } catch (_) {
      _scheduleReconnect(url);
      break;
    }
  }
}

void _scheduleReconnect(String url) {
  if (_disposed) return;
  final delay = _baseDelay * (1 << _retryCount.clamp(0, 6)); // 1s → 2s → 4s … → 64s
  _retryCount++;
  Future.delayed(delay, () => connect(url));
}
```

指数退避必须加。服务端重启时如果所有客户端同时重连，会瞬间打死服务器。

---

## 二、订阅管理：重连后自动重订阅

连接是全新的 session，之前订阅的 channel 全部失效。不重新订阅数据不会推过来，也不会报错——表现就是行情停了。

```dart
final _subscriptions = <String>{};

void subscribe(String channel) {
  _subscriptions.add(channel);
  _send({'op': 'subscribe', 'args': [channel]});
}

void _onConnected() {
  if (_subscriptions.isNotEmpty) {
    _send({'op': 'subscribe', 'args': _subscriptions.toList()});
  }
}
```

---

## 三、App 生命周期感知

iOS 会在 App 进后台几秒到几分钟内杀掉网络连接，但 Dart 这侧感知不到。回前台如果不主动检查，用户会长时间看不到更新。

```dart
class AppLifecycleObserver extends WidgetsBindingObserver {
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
        wsManager.pauseHeartbeat();
        break;
      case AppLifecycleState.resumed:
        wsManager.checkAndReconnect(); // 发 ping，5s 内没 pong 就重连
        break;
      default:
        break;
    }
  }
}
```

---

## 四、连接状态机：别用布尔值

很多实现里用一个 `_isConnected` 布尔值表示连接状态，这是 bug 的温床。真实的连接有 6 个状态：

```
idle → connecting → connected → disconnecting → disconnected → reconnecting → connecting → ...
```

布尔值没法表达"正在重连"和"主动断开"的区别——这两种状态下的行为是完全不同的：
- 正在重连：队列里的消息应该缓存，等连上后补发
- 主动断开：队列应该清空，不需要重连

**用枚举 + 状态机替代布尔值**：

```dart
enum WsState { idle, connecting, connected, reconnecting, disconnecting, disposed }

class WsStateMachine {
  WsState _state = WsState.idle;

  bool canSend() => _state == WsState.connected;
  bool shouldQueue() => _state == WsState.reconnecting;
  bool shouldReconnect() =>
      _state != WsState.disconnecting && _state != WsState.disposed;

  void transition(WsState next) {
    // 防止非法转换，比如从 disposed 转到 connecting
    const allowed = {
      WsState.idle: {WsState.connecting},
      WsState.connecting: {WsState.connected, WsState.reconnecting, WsState.disposed},
      WsState.connected: {WsState.reconnecting, WsState.disconnecting, WsState.disposed},
      WsState.reconnecting: {WsState.connecting, WsState.disposed},
      WsState.disconnecting: {WsState.idle, WsState.disposed},
    };
    assert(allowed[_state]?.contains(next) ?? false,
        'invalid transition: $_state -> $next');
    _state = next;
  }
}
```

状态机一旦建起来，很多散落在各处的 if 判断都可以收进来，逻辑清晰很多。

---

## 五、重连竞态：两个 Future 同时建连

写重连时很容易手滑写出这样的代码：

```dart
void _onDisconnected() {
  Future.delayed(Duration(seconds: 2), () async {
    await connect(); // 问题在这里
  });
}
```

如果 `_onDisconnected` 被触发了两次（`onError` 和 `onDone` 同时触发，这很常见），就会有两个 Future 同时尝试建立连接，最终可能两个连接都建立成功，但只有一个被赋值给 `_socket`，另一个泄漏了。

**用 CancelableOperation 或版本号解决**：

```dart
int _connectGeneration = 0;

Future<void> connect() async {
  final generation = ++_connectGeneration;

  final socket = await WebSocket.connect(url);

  // 如果在建连期间有新的 connect() 调用，generation 已经变了
  if (generation != _connectGeneration) {
    socket.close(); // 这个连接作废
    return;
  }

  _socket = socket;
  // ...
}
```

每次调用 connect 时递增版本号，旧的连接建立后发现版本不对就主动关闭。

---

## 六、订单簿序列号 Gap

订单簿更新通常是这个模式：

1. 先请求一次 snapshot（完整数据）
2. 之后持续接收 delta（增量变更）
3. 本地用 snapshot + delta 维护本地订单簿

这里有一个绕不过去的问题：**WebSocket 重连期间 delta 会丢失**。

```
snapshot seq=1000
delta seq=1001 ✓
delta seq=1002 ✓
--- 断线 ---
重连后：
delta seq=1005 ← seq 1003、1004 丢了，本地订单簿已经失效
```

如果不处理这个 gap，本地维护的订单簿会越来越偏离真实值，用户看到的深度图是错的。

**正确的处理逻辑**：

```dart
class OrderbookManager {
  Map<double, double> _bids = {};
  Map<double, double> _asks = {};
  int? _lastSeq;
  bool _waitingForSnapshot = false;

  void applySnapshot(OrderbookSnapshot snapshot) {
    _bids = Map.fromEntries(snapshot.bids.map((e) => MapEntry(e.price, e.qty)));
    _asks = Map.fromEntries(snapshot.asks.map((e) => MapEntry(e.price, e.qty)));
    _lastSeq = snapshot.seq;
    _waitingForSnapshot = false;
  }

  void applyDelta(OrderbookDelta delta) {
    if (_waitingForSnapshot) return; // 等 snapshot 期间的 delta 直接丢弃

    final expectedSeq = (_lastSeq ?? 0) + 1;
    if (delta.seq > expectedSeq) {
      // 发现 gap：立刻重新请求 snapshot
      _waitingForSnapshot = true;
      _bids.clear();
      _asks.clear();
      requestSnapshot(); // 触发重新订阅或 REST 拉取
      return;
    }
    if (delta.seq < expectedSeq) return; // 重复消息，忽略

    // 正常应用
    _applyChanges(delta);
    _lastSeq = delta.seq;
  }

  void _applyChanges(OrderbookDelta delta) {
    for (final change in delta.bids) {
      if (change.qty == 0) {
        _bids.remove(change.price); // qty=0 表示删除这个价格档
      } else {
        _bids[change.price] = change.qty;
      }
    }
    // asks 同理
  }
}
```

这个逻辑很多实现都没做，结果就是断线重连后行情数据悄悄出错，但没有任何报错提示。

---

## 七、消息积压与背压

WebSocket 消息进来的速度和 UI 更新的速度不匹配，是高频行情场景的真实问题。

**典型现象**：网络好的时候，每秒几十条 ticker 推进来，但 UI 60fps 只能处理 16ms 一帧，如果每条消息都触发 `setState`，会有大量冗余重建。

**解法：节流（Throttle）而不是每条都更新**：

```dart
class ThrottledMarketNotifier extends StateNotifier<TickerState> {
  Timer? _flushTimer;
  TickerState? _pending;

  void onMessage(TickerState newState) {
    _pending = newState; // 只保留最新值

    // 尚未安排刷新才创建 timer
    _flushTimer ??= Timer(Duration(milliseconds: 100), _flush);
  }

  void _flush() {
    _flushTimer = null;
    if (_pending != null) {
      state = _pending!;
      _pending = null;
    }
  }
}
```

100ms 内的多条消息只触发一次 UI 更新，丢弃的都是中间态，最终态一定会到达。

**对于订单簿**，还有一个额外问题：不同价格档的更新频率不同，top-of-book 更新极频繁，而远端价格几乎不变。可以做分层更新，只 diff 发生变化的部分：

```dart
void _applyAndNotify(Map<double, double> oldBids, Map<double, double> newBids) {
  final changed = <double>[];
  for (final entry in newBids.entries) {
    if (oldBids[entry.key] != entry.value) changed.add(entry.key);
  }
  // 只通知发生变化的档位，而不是全量重建
  if (changed.isNotEmpty) ref.notifyListeners();
}
```

---

## 八、认证 Token 在连接中途过期

很多交易所的私有 channel（订单状态、账户余额）需要认证。Token 通常有过期时间，而 WebSocket 连接可能存活几小时。

**两种方案**：

**方案 A：连接上就认证，token 过期主动重连**

```dart
void _onConnected() async {
  await _authenticate();
  _scheduleTokenRefresh();
}

void _scheduleTokenRefresh() {
  final expiresIn = _token.expiresAt.difference(DateTime.now()) - Duration(minutes: 2);
  Timer(expiresIn, () async {
    // token 快到期：刷新后重新认证，或者重建连接
    await _refreshToken();
    await _authenticate(); // 部分交易所支持在同一连接上重新 auth
  });
}
```

**方案 B：token 过期时服务端会主动推一条错误消息，监听它**

```dart
void _onMessage(dynamic raw) {
  final msg = jsonDecode(raw);
  if (msg['code'] == 'TOKEN_EXPIRED') {
    _refreshAndReauthenticate();
    return;
  }
  _dispatch(msg);
}
```

实际开发中两种情况都会遇到，取决于交易所的协议设计，两个都要处理。

---

## 九、多路复用 vs 多连接

随着订阅的 channel 变多，有时候会遇到一个实际限制：**单个 WebSocket 连接的订阅数量上限**（部分交易所限制单连接最多订阅 20 个 channel）。

这时候有两个选择：

**选项 A：多条连接，每条负责一部分 channel**

```dart
final _connections = <String, WsConnection>{}; // endpoint -> connection

WsConnection _getOrCreate(String endpoint) {
  return _connections.putIfAbsent(endpoint, () {
    final conn = WsConnection(endpoint);
    conn.connect();
    return conn;
  });
}
```

**选项 B：连接池 + 动态分配**

```dart
class WsPool {
  static const maxChannelsPerConn = 20;
  final _pool = <WsConnection>[];

  WsConnection allocate() {
    // 找一个还有空余订阅位的连接
    return _pool.firstWhere(
      (c) => c.subscriptionCount < maxChannelsPerConn,
      orElse: () {
        final conn = WsConnection(_endpoint)..connect();
        _pool.add(conn);
        return conn;
      },
    );
  }
}
```

选项 B 在 channel 数量动态变化时更灵活，但连接的生命周期管理更复杂（什么时候回收空连接）。一般交易所场景选项 A 按 endpoint 分连接就够了。

---

## 十、消息解析：常驻 Isolate 拓扑

行情高峰期消息量大，JSON 解析不能在主 Isolate 做。但 Isolate 间通信有开销，拓扑设计不对反而更慢。

两种方案的对比：

**每条消息 compute()**：启动开销大，每次都要序列化/反序列化参数，高频下不适合。

**常驻 Isolate + SendPort 通信**：一次启动，后续只传数据。适合高频场景。

```dart
class ParseIsolate {
  late SendPort _sendPort;
  late ReceivePort _receivePort;
  final _pending = <int, Completer<Map<String, dynamic>>>{};
  int _seq = 0;

  Future<void> init() async {
    _receivePort = ReceivePort();
    await Isolate.spawn(_worker, _receivePort.sendPort);
    _sendPort = await _receivePort.first;
    _receivePort.listen((msg) {
      final result = msg as (int, Map<String, dynamic>);
      _pending.remove(result.$1)?.complete(result.$2);
    });
  }

  Future<Map<String, dynamic>> parse(String raw) {
    final seq = _seq++;
    final completer = Completer<Map<String, dynamic>>();
    _pending[seq] = completer;
    _sendPort.send((seq, raw));
    return completer.future;
  }

  static void _worker(SendPort port) {
    final recv = ReceivePort();
    port.send(recv.sendPort);
    recv.listen((msg) {
      final req = msg as (int, String);
      final parsed = jsonDecode(req.$2) as Map<String, dynamic>;
      port.send((req.$1, parsed));
    });
  }
}
```

带 seq 是为了保证响应能对上请求，Isolate 里可以并发处理。

---

## 总结

真正难的问题集中在几个地方：

- **状态机** 替代布尔值，防止并发下的状态撕裂
- **重连竞态** 用版本号防止多个连接并存泄漏
- **序列号 Gap** 检测，订单簿失效时必须重拉 snapshot
- **背压** 节流，防止高频推送打爆 UI 渲染
- **Token 过期** 在连接存活期间静默续期

这几个点任何一个没做到位，表现出来都是"偶发性数据错误"或"行情偶尔不动"，排查起来比较隐蔽。
