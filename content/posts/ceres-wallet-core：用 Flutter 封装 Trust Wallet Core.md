---
date: 2026-04-16T16:00:00-00:00
tags: ["flutter", "web3", "wallet", "ffi"]
title: "ceres-wallet-core：用 Flutter 封装 Trust Wallet Core"
---

# ceres-wallet-core：用 Flutter 封装 Trust Wallet Core

## 背景

在做 Flutter 钱包应用时，密钥管理和交易签名是绕不开的核心模块。社区里能用的方案要么只支持 EVM 单链、要么 Dart 原生实现存在安全隐患、要么直接调 Web3 RPC 把私钥暴露在网络层。

[Trust Wallet Core](https://github.com/trustwallet/wallet-core) 是目前业界覆盖链最广、经过生产验证的开源密钥库，用 C++ 实现，已经支持 60+ 条链。问题是它没有官方的 Flutter 绑定。

**ceres-wallet-core** 就是为了解决这个问题：通过 Dart FFI 将 Trust Wallet Core 的能力完整引入 Flutter，并在上层封装成符合 Dart 习惯的 API。

## 支持的链

- **主链**：Ethereum、Solana、Sui、Tron
- **EVM L2**：Polygon、Arbitrum、Base、Optimism、Avalanche、BNB Chain、zkSync Era、Linea、Scroll、Mantle、Blast 等 27+ 条

## 核心功能

### 1. HD 钱包创建与导入

```dart
// 创建新钱包（随机生成助记词）
final wallet = TWHDWallet();
print(wallet.mnemonic); // 24 个英文单词

// 从助记词恢复
final wallet = TWHDWallet.createWithMnemonic(
  mnemonic: 'word1 word2 ... word24',
  passphrase: '',
);
```

BIP39 助记词验证：

```dart
final isValid = TWMnemonic.isValid('word1 word2 ... word24');
```

### 2. 多链地址派生

```dart
// 按 BIP44 标准派生地址
final ethAddress = wallet.getAddressForCoin(TWCoinType.ethereum);
final solAddress = wallet.getAddressForCoin(TWCoinType.solana);
final suiAddress = wallet.getAddressForCoin(TWCoinType.sui);

// 自定义派生路径
final key = wallet.getKey(
  coin: TWCoinType.ethereum,
  derivationPath: "m/44'/60'/0'/0/1",
);
```

### 3. 交易签名

以 ETH 转账为例，使用 protobuf 描述交易：

```dart
final signingInput = Ethereum.SigningInput(
  chainId: Int64(1).toBytes(),
  nonce: Int64(nonce).toBytes(),
  gasLimit: Int64(21000).toBytes(),
  maxFeePerGas: gweiToBytes(30),
  maxInclusionFeePerGas: gweiToBytes(2),
  toAddress: '0xRecipient...',
  transaction: Ethereum.Transaction(
    transfer: Ethereum.Transaction_Transfer(
      amount: etherToBytes(0.01),
    ),
  ),
  privateKey: privateKey.data,
);

final output = TWAnySigner.sign(
  input: signingInput.writeToBuffer(),
  coin: TWCoinType.ethereum,
);

final signed = Ethereum.SigningOutput.fromBuffer(output);
print(signed.encoded.toHex()); // 可直接广播的 raw transaction
```

### 4. 地址验证

```dart
final isValid = TWAnyAddress.isValid(
  address: '0xAbCd...',
  coin: TWCoinType.ethereum,
);
```

## 技术设计

### FFI 层结构

```
lib/
  src/           # 高层 Dart 封装（TWHDWallet、TWAnySigner 等）
  bindings/      # ffigen 自动生成的 C 绑定
  proto/         # 各链的 protobuf 模型
third_party/
  wallet-core/   # Trust Wallet Core 的 git submodule
```

Trust Wallet Core 的 C API 通过 ffigen 自动生成 Dart 绑定，上层再封装成更友好的类，隔离掉 FFI 的 `Pointer` 操作细节。

### 内存安全

C++ 对象需要手动释放，这在 FFI 层是个常见的内存泄漏来源。这里用 Dart 的 `Finalizer` 机制在 GC 回收 Dart 对象时自动调用 native 的 `delete` 方法：

```dart
class TWHDWallet {
  final Pointer<bindings.TWHDWallet> _ptr;
  static final _finalizer = Finalizer<Pointer<bindings.TWHDWallet>>(
    (ptr) => _bindings.TWHDWalletDelete(ptr),
  );

  TWHDWallet._(this._ptr) {
    _finalizer.attach(this, _ptr, detach: this);
  }
}
```

### Native 库分发

通过 Dart Build Hooks（`hook/build.dart`）在构建时自动下载对应平台的预编译 `.so` / `.a` / `.dylib`，不需要开发者手动配置 CMake 或复制 native 库文件。

## 接入

```yaml
dependencies:
  ceres_wallet_core:
    git:
      url: https://github.com/SauceWu/ceres-wallet-core.git
```

需要 Flutter >= 3.38.0、Dart >= 3.9.0，iOS 13+，Android API 21+。

## 开源地址

[https://github.com/SauceWu/ceres-wallet-core](https://github.com/SauceWu/ceres-wallet-core)
