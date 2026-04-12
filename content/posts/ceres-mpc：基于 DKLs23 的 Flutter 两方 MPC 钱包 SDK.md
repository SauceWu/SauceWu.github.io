---
date: 2026-04-12T17:00:00-00:00
tags: ["flutter", "web3", "mpc", "cryptography"]
title: "ceres-mpc：基于 DKLs23 的 Flutter 两方 MPC 钱包 SDK"
---

# ceres-mpc：基于 DKLs23 的 Flutter 两方 MPC 钱包 SDK

## 为什么需要 MPC 钱包

传统 HD 钱包的私钥完整存储在用户设备上，一旦设备丢失或被攻击，资产就没了。助记词备份虽然能恢复，但本身也是攻击面。

MPC（Multi-Party Computation）钱包的思路是：**私钥从始至终都不存在于任何单一设备**，签名由多方协作计算完成。两方 ECDSA 的典型部署是客户端持有一份密钥分片，服务端持有另一份，任意一方单独都无法完成签名。

**ceres-mpc** 基于 [DKLs23 协议](https://eprint.iacr.org/2023/765) 实现了一套完整的 Flutter MPC 钱包 SDK，密码学核心用 Rust 编写，通过 flutter_rust_bridge 暴露给 Dart 调度层。

## 核心功能

| 功能 | 说明 |
|------|------|
| 密钥生成（Keygen） | 两方协作生成 secp256k1 密钥对，输出各自的 Keyshare 和 EVM 地址 |
| 交易签名（Sign） | 两方协作完成 ECDSA 签名，返回 (r, s, recid) |
| 密钥恢复（Recovery） | DKLs23 密钥刷新，保留原链上地址，更新轮次版本 |
| 备份与恢复 | AES-256-GCM 加密备份信封，支持跨设备恢复 |
| 私钥导出 | 重建完整私钥，迁移到普通钱包（不可逆操作） |

## 架构设计

```
Host App（负责网络传输和存储）
         ↓
    MpcClient          Dart 编排层，唯一对外 API
         ↓
    MpcEngine          Dart FFI 封装层（内部，不对外）
         ↓  flutter_rust_bridge
    Rust Core          sl-dkls23 密码学实现
```

设计原则：**SDK 只管密码学，网络和存储由宿主 App 负责**。

宿主 App 注入一个实现了 `MpcTransport` 接口的对象，SDK 通过它发送协议消息，完全不关心底层是 HTTP 还是 WebSocket：

```dart
abstract class MpcTransport {
  Future<String> send(String payload);
}
```

## 协议流程

DKLs23 内部是 4 轮协议，但通过**批量消息合并**优化，压缩到 **3 次 HTTP 往返**：

```
Client (Party2)                Server (Party1)
      |                              |
      |  keygen round=1 →            |
      |  ← { sessionId, R1 batch }   |
      |                              |
      |  [Rust] 本地计算              |
      |                              |
      |  keygen round=2 →            |
      |  ← { R2 batch }              |
      |                              |
      |  keygen round=3 →            |
      |  ← { R3 + Keyshare 已持久化 } |
      |                              |
      ↓  KeygenResult                ↓
```

第 3 轮服务端在返回响应前已预先持久化密钥分片，避免客户端拿到结果但服务端未保存的竞态问题。

## 使用方式

### 初始化

```dart
final client = MpcClient(
  transport: HttpMpcTransport(rpcUrl: 'https://your-mpc-server/rpc'),
);
```

### 密钥生成

```dart
final result = await client.keygen();
print(result.address);           // 0xAbCd... EVM 地址
print(result.encryptedShare);    // 加密后的本地分片，需持久化
```

### 交易签名

```dart
// messageHash 是 32 字节的待签名哈希（如 keccak256(rlp(tx))）
final sig = await client.sign(
  mpcKeyId: result.mpcKeyId,
  messageHash: '0xdeadbeef...',
  localEncryptedShare: result.encryptedShare,
);

// 组装 EIP-155 签名
final v = sig.recid + 27;
final rawTx = encodeSignedTx(sig.r, sig.s, v);
```

### 密钥恢复（换设备 / 轮换分片）

```dart
final recovered = await client.recover(
  mpcKeyId: oldResult.mpcKeyId,
  encryptedBackupShare: backupEnvelope,
  userBackupSecret: userPassword,
  currentRotationVersion: 0,
);
// recovered.address 与原地址相同，rotationVersion 加 1
```

## 安全细节

**Keyshare 保护**：`KeygenResult` 重写了 `toString()`，所有敏感分片内容输出为 `[REDACTED]`，防止意外打印到日志。

**会话状态**：协议过程中的临时状态存在内存的 `Mutex` Map 里，协议结束后立即清理，不落盘。

**备份加密**：本地分片备份使用 AES-256-GCM，密钥由用户口令派生，SDK 不感知具体的存储位置。

**私钥导出**：导出后服务端标记该 Key 为 exported 状态，后续 MPC 操作全部拒绝，防止分片被分别利用。

## 服务端接入

服务端需实现一个 JSON-RPC 2.0 接口（POST /rpc），处理 `keygen`、`sign`、`recovery`、`export_key` 四个方法，用 Rust 的 `sl-dkls23` crate 跑 Party1 侧的协议逻辑。

详见 [SERVER_INTEGRATION.md](https://github.com/SauceWu/ceres-mpc/blob/main/doc/SERVER_INTEGRATION.md)。

## 接入

```yaml
dependencies:
  ceres_mpc:
    git:
      url: https://github.com/SauceWu/ceres-mpc.git
```

支持 Android（arm64、armv7、x86_64）和 iOS（arm64、Simulator），预编译 Rust 产物通过 cargokit 自动下载。

## 开源地址

[https://github.com/SauceWu/ceres-mpc](https://github.com/SauceWu/ceres-mpc)
