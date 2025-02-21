---
date: 2025-02-21T15:00:00+09:00
tags: ["web3", "solana", "gas", "transaction"]
title: "Solana 交易手续费与常见坑"
---

# Solana 交易手续费与常见坑

Solana 的手续费设计和 EVM 差别很大，从 EVM 过来的开发者很容易踩坑。这篇把几个最常见的问题整理一下。

---

## 手续费结构

Solana 的交易费用分两部分：

```
总费用 = 基础费用（Base Fee）+ 优先费用（Priority Fee，可选）
```

### 基础费用

每个**签名**收 `5000 lamports`（0.000005 SOL）。一笔交易有几个签名就收几倍。

```
基础费用 = 签名数 × 5000 lamports
```

普通转账只有 1 个签名，费用就是 5000 lamports。多签或者复杂交易有多个签名，费用叠加。

### 优先费用（Compute Units）

这是 Solana 对应 EVM Gas 的概念，但定价方式不同：

```
优先费用 = computeUnitPrice × computeUnitLimit / 1_000_000
单位：lamports
```

- `computeUnitLimit`：这笔交易最多消耗多少算力单元（CU），默认上限 200,000 CU
- `computeUnitPrice`：每个 CU 愿意付多少 micro-lamports（百万分之一 lamports）

网络空闲时优先费用设 0 也能上链，拥堵时需要设高一点竞争排名。

---

## 怎么设置优先费用

通过两条专用指令写进交易：

```dart
final instructions = [
  // 设置这笔交易的 CU 上限（按需调小，省钱）
  ComputeBudgetProgram.setComputeUnitLimit(units: 50000),

  // 设置优先费用：每 CU 多少 micro-lamports
  ComputeBudgetProgram.setComputeUnitPrice(microLamports: 1000),

  // 实际业务指令
  SystemProgram.transfer(
    fromPubkey: sender,
    toPubkey: receiver,
    lamports: amount,
  ),
];
```

查询当前网络建议的优先费用：

```
getRecentPrioritizationFees RPC
```

返回最近几个 slot 各个百分位的费用，一般取 75 分位作为"普通速度"的参考。

---

## 坑 1：Account Rent（账户租金）

这是最容易让 EVM 开发者懵的地方。

Solana 上每个账户都要占用链上存储，存储不是免费的。每个账户需要维持一定数量的 SOL 作为**租金押金（rent-exempt balance）**，只要账户存在这笔钱就锁在里面，账户关闭时才退回。

最小 rent-exempt 数量：
```
约 0.00203928 SOL（2039280 lamports）
```

**实际踩坑场景**：

给一个**从未使用过的地址**转账时，如果转账金额低于 rent-exempt 最低值，交易会成功，但目标账户的余额不够维持 rent，这笔钱就"卡"在一个状态不稳定的账户里。

正确做法：首次给新地址转账时，转账金额至少要 `>= rent-exempt minimum`，或者在转账前用 `getMinimumBalanceForRentExemption` 查询。

---

## 坑 2：交易有效期很短

Solana 交易里包含一个 `recentBlockhash`，这个 blockhash **大约 60-90 秒后过期**。

过期后交易无法上链，直接报错：

```
Transaction simulation failed: Blockhash not found
```

**坑在哪**：EVM 的交易可以在 mempool 里等很久，用户签完名可以几分钟后再广播。Solana 不行，签名和广播必须尽量连续，或者使用 **durable nonce**（持久化 nonce，专门解决这个问题）。

做钱包的话，签名和广播之间不要插入太多用户交互步骤。

---

## 坑 3：交易大小限制

Solana 交易最大 **1232 字节**。

一笔交易里指令太多、账户太多都会超限，直接被节点拒绝。

常见超限场景：
- 批量 Token 转账一次打包太多
- NFT mint 指令复杂，accounts 列表太长

解决方案是拆成多笔交易，或者使用 `VersionedTransaction + Address Lookup Tables`（ALT，地址查找表）压缩 accounts 列表。

---

## 坑 4：SPL Token 转账需要 ATA

给别人转 SPL Token（不是 SOL）时，目标地址必须有对应 Token 的 **Associated Token Account（ATA）**。

如果目标没有 ATA，你有两个选择：

1. **先帮他创建 ATA**，费用由发送方支付（约 0.002 SOL 的 rent）
2. **检查 ATA 是否存在**，不存在就提示用户或自动创建

```
// 检查 ATA 是否存在
getAccountInfo(ata_address)
// null 表示不存在，需要先 createAssociatedTokenAccount
```

直接发 Token 到一个没有 ATA 的地址，交易会失败。

---

## 坑 5：simulateTransaction 结果不等于成功

Solana 的 `simulateTransaction` 可以在发送前预估 CU 消耗和检查错误，很多人用这个来确认交易没问题。

但有一个坑：simulate 是在当前状态下执行，实际广播时链上状态可能已经变了（比如余额变化、账户状态变化），simulate 成功不代表上链一定成功。

特别是 DeFi 操作（swap、借贷），simulate 和实际执行之间的状态差异可能导致实际失败。

---

## 手续费估算实践

```dart
// 1. 获取近期优先费用建议
final fees = await connection.getRecentPrioritizationFees(
  lockedWritableAccounts: [involvedAccounts],
);
// 取 75 分位
final p75 = fees.sortedBy((f) => f.prioritizationFee)[fees.length * 3 ~/ 4];

// 2. 模拟交易获取实际 CU 消耗
final sim = await connection.simulateTransaction(tx);
final cuUsed = sim.value.unitsConsumed ?? 200000;
// 实际设置时给 CU 留 20% 缓冲
final cuLimit = (cuUsed * 1.2).toInt();

// 3. 计算总费用
final priorityFee = p75.prioritizationFee * cuLimit ~/ 1_000_000;
final baseFee = 5000 * signatureCount;
final totalFee = baseFee + priorityFee;
```

---

## 小结

| 问题 | EVM 行为 | Solana 行为 |
|------|---------|------------|
| 手续费单位 | Gas × GasPrice | 签名费 + CU × CUPrice |
| 新地址转账 | 随时可以 | 需要考虑 rent |
| 交易有效期 | mempool 里等很久 | ~90 秒，过期作废 |
| 代币转账 | 直接转 | 目标需要 ATA |
| 交易大小 | 相对宽松 | 1232 字节上限 |

Solana 的手续费本身很便宜，真正贵的是 rent 和 ATA 创建。做钱包的时候首次转账前检查目标地址状态是必须的，否则用户体验会很差。
