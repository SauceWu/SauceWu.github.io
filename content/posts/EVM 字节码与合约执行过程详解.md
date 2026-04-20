---
date: 2023-04-20T14:00:00-00:00
tags: ["web3", "evm", "solidity", "blockchain"]
title: "EVM 字节码与合约执行过程详解"
---

# EVM 字节码与合约执行过程详解

## 目录

- 一、EVM 是什么
- 二、Solidity 到字节码的编译过程
- 三、EVM 的运行时结构
- 四、核心 OPCODE 分类详解
- 五、一个完整的合约调用流程
- 六、Gas 的本质
- 七、常见安全问题的字节码视角
- 八、总结

---

## 一、EVM 是什么

EVM（Ethereum Virtual Machine）是以太坊的智能合约运行环境。它是一个**基于栈的虚拟机**，与 JVM 的基于栈架构类似，但设计上做了很多针对区块链场景的取舍：

- **确定性**：相同输入永远产生相同输出，所有节点独立执行后结果必须一致
- **隔离性**：合约运行在沙箱里，无法访问网络、文件系统、随机数
- **计量性**：每条指令都有固定 Gas 费用，防止无限循环

EVM 使用 **256 位字长**（32 字节），这是它最核心的设计决定——与 Keccak-256 哈希和椭圆曲线密钥长度对齐，避免频繁的位数转换。

---

## 二、Solidity 到字节码的编译过程

### 2.1 编译流程

```
Solidity 源码
     ↓  solc 解析
  AST（抽象语法树）
     ↓  语义分析、类型检查
  IR（中间表示，Yul）
     ↓  优化器
  EVM 字节码（十六进制）
     ↓
  ABI（JSON 接口描述）
```

用 `solc` 编译一个简单合约：

```bash
solc --bin --abi SimpleStorage.sol
```

### 2.2 字节码的两个部分

编译出来的字节码实际上包含**两段**：

```
[ Creation Code ] [ Runtime Code ]
```

- **Creation Code**：部署时执行一次，负责初始化合约（执行 constructor）、把 Runtime Code 写入链上存储，然后自毁
- **Runtime Code**：部署完成后永久存储在链上，每次调用合约时 EVM 加载并执行的才是这部分

### 2.3 一个最简单的例子

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Counter {
    uint256 public count;

    function increment() external {
        count += 1;
    }
}
```

编译后 Runtime Code 的十六进制开头大概长这样：

```
6080604052...
```

`60 80` 是 `PUSH1 0x80`，`60 40` 是 `PUSH1 0x40`，`52` 是 `MSTORE`——这三条指令在初始化 "free memory pointer"（空闲内存指针，固定存在 0x40 位置），几乎每个合约都以此开头。

---

## 三、EVM 的运行时结构

EVM 执行合约时维护以下数据区域：

### 3.1 Stack（栈）

- 最大深度 **1024**，每个元素 32 字节
- 所有运算指令（ADD、MUL、AND...）都从栈顶取操作数，结果压回栈顶
- 只能访问栈顶的 16 个元素（SWAP1~SWAP16、DUP1~DUP16），深层数据需要先换上来

```
Stack:
┌───────────┐  ← 栈顶（最新 PUSH 的值）
│  0x000...3│
├───────────┤
│  0x000...1│
└───────────┘
```

### 3.2 Memory（内存）

- 线性字节数组，**按需扩展**，初始为空
- 读写以 32 字节为单位（`MLOAD` / `MSTORE`），也支持单字节（`MSTORE8`）
- 每次扩展内存都要付 Gas，且费用随用量**二次增长**（防止滥用）
- 调用结束后**自动清空**，不持久化

### 3.3 Storage（存储）

- **键值对**结构，key 和 value 都是 32 字节
- 持久化在区块链上，跨调用保留
- 读写成本极高：`SSTORE`（写）首次 20000 Gas，`SLOAD`（读）2100 Gas
- Solidity 中的状态变量（`uint256 count`）就存在 Storage 里，按声明顺序从 slot 0 开始排列

### 3.4 Calldata

- 调用合约时传入的只读数据，即函数选择器 + 参数编码
- 读取用 `CALLDATALOAD` / `CALLDATACOPY`，比 Memory 便宜

### 3.5 PC（程序计数器）

- 指向当前执行的字节码位置
- `JUMP` / `JUMPI` 指令修改 PC，实现条件跳转（对应 if/for/while）
- 只能跳转到标记了 `JUMPDEST` 的位置，防止跳入数据段执行乱码

---

## 四、核心 OPCODE 分类详解

### 4.1 栈操作

| OPCODE | 说明 |
|--------|------|
| `PUSH1`~`PUSH32` | 把 N 字节常量压栈 |
| `POP` | 弹出栈顶 |
| `DUP1`~`DUP16` | 复制栈中第 N 个元素到栈顶 |
| `SWAP1`~`SWAP16` | 交换栈顶与第 N+1 个元素 |

### 4.2 算术与位运算

| OPCODE | Solidity 对应 |
|--------|--------------|
| `ADD` / `SUB` / `MUL` / `DIV` | `+` `-` `*` `/` |
| `MOD` | `%` |
| `EXP` | `**` |
| `LT` / `GT` / `EQ` / `ISZERO` | `<` `>` `==` `!` |
| `AND` / `OR` / `XOR` / `NOT` | `&` `\|` `^` `~` |
| `SHL` / `SHR` | `<<` `>>` |

注意：EVM 没有原生浮点数，Solidity 里的 `uint256` 就是 256 位无符号整数，小数要用定点数（如 `1e18` 表示 1 个代币）。

### 4.3 存储与内存

| OPCODE | 说明 | Gas |
|--------|------|-----|
| `SLOAD` | 读 Storage slot | 2100 |
| `SSTORE` | 写 Storage slot（首次） | 20000 |
| `MLOAD` | 读 32 字节内存 | 3 |
| `MSTORE` | 写 32 字节内存 | 3 |
| `CALLDATALOAD` | 读 32 字节 calldata | 3 |

### 4.4 控制流

| OPCODE | 说明 |
|--------|------|
| `JUMP` | 无条件跳转到栈顶指定位置 |
| `JUMPI` | 条件跳转（第二个栈元素非零时跳） |
| `JUMPDEST` | 合法跳转目标标记 |
| `STOP` | 正常结束执行 |
| `REVERT` | 回滚所有状态变更，返回错误数据 |
| `RETURN` | 正常结束，返回 Memory 中的数据 |

### 4.5 合约交互

| OPCODE | 说明 |
|--------|------|
| `CALL` | 调用另一个合约，转发 ETH 和 calldata |
| `STATICCALL` | 只读调用，被调方不能修改状态 |
| `DELEGATECALL` | 用调用方的 Storage 执行被调方的代码（Proxy 的核心） |
| `CREATE` / `CREATE2` | 部署新合约 |
| `SELFDESTRUCT` | 销毁合约，余额转给指定地址 |

---

## 五、一个完整的合约调用流程

以调用 `Counter.increment()` 为例，从发出交易到状态更新：

### 5.1 构造 Calldata

```
函数选择器 = keccak256("increment()") 的前 4 字节
           = 0xd09de08a
```

`increment()` 没有参数，所以 calldata 就是 `0xd09de08a`。

### 5.2 EVM 分发函数调用

Runtime Code 开头是一段 **dispatcher（分发器）** 逻辑，本质上是一堆 if-else：

```
CALLDATALOAD(0)        // 读取前 32 字节
PUSH 0xe0
SHR                    // 右移 224 位，取前 4 字节（函数选择器）

// 依次比较每个函数选择器
DUP1
PUSH 0xd09de08a        // increment() 的选择器
EQ
JUMPI → increment 代码段

DUP1
PUSH 0x06661abd        // count() 的选择器
EQ
JUMPI → count 代码段

REVERT                 // 没匹配到，回滚
```

### 5.3 执行 increment

```
// count += 1 对应的字节码逻辑：
PUSH 0x00          // count 在 slot 0
SLOAD              // 读取 Storage[0]，得到当前 count 值
PUSH 0x01
ADD                // count + 1
PUSH 0x00
SSTORE             // 写回 Storage[0]
STOP
```

### 5.4 状态提交

EVM 执行完成且没有 REVERT，节点把 Storage 的变更写入 Merkle Patricia Trie，更新账户状态根，打包进区块。

---

## 六、Gas 的本质

Gas 是 EVM 指令的**计算资源计量单位**，用来防止：
1. 无限循环耗尽节点资源
2. 廉价存储大量数据

### Gas 费用的直觉

| 操作 | Gas | 理由 |
|------|-----|------|
| `ADD` | 3 | 纯 CPU 运算，极便宜 |
| `MLOAD/MSTORE` | 3 | 内存读写，较便宜 |
| `SLOAD` | 2100 | 磁盘读，贵 |
| `SSTORE`（新写） | 20000 | 链上永久存储，最贵 |
| `KECCAK256` | 30 + 6×字节数 | 哈希计算 |
| `CALL` | 至少 700 | 跨合约调用开销 |

### Gas 优化的核心思路

**1. 减少 Storage 读写**

```solidity
// ❌ 循环里每次都读 Storage
for (uint i = 0; i < items.length; i++) {
    total += balances[msg.sender]; // SLOAD 在循环里
}

// ✅ 读一次缓存到 Memory
uint256 balance = balances[msg.sender]; // 一次 SLOAD
for (uint i = 0; i < items.length; i++) {
    total += balance; // 只用 MLOAD
}
```

**2. 使用更小的数据类型要谨慎**

EVM 内部始终用 32 字节运算，`uint8` 和 `uint256` 的运算成本一样。`uint8` 只在 Storage slot packing（多个小变量共用一个 slot）时才能省 Gas：

```solidity
// ✅ 三个变量共用一个 slot（共 1+1+30=32 字节）
uint8 a;    // 1 字节
uint8 b;    // 1 字节
uint240 c;  // 30 字节
// 以上三个变量打包进同一个 Storage slot
```

**3. 用 `immutable` 和 `constant`**

```solidity
uint256 public constant MAX_SUPPLY = 10000;    // 编译期内联为 PUSH，不占 Storage
address public immutable owner;                // 部署时写入字节码，读取只需 PUSH
```

---

## 七、常见安全问题的字节码视角

### 7.1 重入攻击（Reentrancy）

`CALL` 在转账时会把控制权交给被调合约，被调合约可以在你的状态更新之前再次调用你：

```solidity
// ❌ 先转账再更新状态
function withdraw() external {
    uint amount = balances[msg.sender];
    (bool ok,) = msg.sender.call{value: amount}(""); // CALL：控制权转移
    balances[msg.sender] = 0;  // 攻击者在这行执行前就再次调用 withdraw
}

// ✅ Checks-Effects-Interactions 模式
function withdraw() external {
    uint amount = balances[msg.sender];
    balances[msg.sender] = 0;  // 先改状态
    (bool ok,) = msg.sender.call{value: amount}(""); // 再转账
}
```

### 7.2 整数溢出

Solidity 0.8.0 之前没有溢出检查，`uint256` 加到最大值后会绕回 0。0.8.0 起编译器自动加入溢出检查（底层插入 `REVERT` 分支），但这也意味着 Gas 略有上升。

如果追求 Gas 极致，可以用 `unchecked` 块跳过检查（确认不会溢出时）：

```solidity
unchecked {
    i++; // 确认不会溢出时节省 Gas
}
```

### 7.3 delegatecall 的存储布局陷阱

`DELEGATECALL` 用调用方的 Storage 执行被调方代码。Proxy 合约和 Logic 合约的状态变量**顺序必须严格一致**，否则 slot 错位会覆盖错误的变量：

```solidity
// Proxy:           slot 0 = address implementation
// Logic (错误):    slot 0 = address owner   ← 执行时会覆盖 implementation
```

这是 Proxy 升级合约中最常见的严重漏洞之一。

---

## 八、总结

- **EVM 是基于栈的 256 位虚拟机**，设计目标是确定性、隔离性和可计量性
- **Solidity 编译产物分两段**：Creation Code 负责部署，Runtime Code 负责运行
- **核心数据区域**：Stack（运算）、Memory（临时）、Storage（持久）、Calldata（输入）
- **函数调用**通过匹配 4 字节选择器分发，本质是 if-else 跳转表
- **Gas 优化的重点**永远是减少 SSTORE/SLOAD，其次是减少 CALL
- **安全问题**大多来自对 EVM 执行顺序和存储布局的错误假设

理解字节码层的行为，是写出安全、高效合约的底层基础。
