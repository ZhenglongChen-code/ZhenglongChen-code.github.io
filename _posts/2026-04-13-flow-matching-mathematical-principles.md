---
layout: page
title: "Flow Matching: 数学原理与公式推导"
date: 2026-04-13
categories: [机器学习, 生成模型]
cover_image: https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=1200&q=80
---


## 引言

Flow Matching (FM) 是由 Lipman et al. (2022) 提出的一类新型生成模型框架。与扩散模型 (Diffusion Models) 不同，Flow Matching 通过学习一个由常微分方程 (ODE) 驱动的**连续归一化流** (Continuous Normalizing Flow, CNF)，将简单分布（如高斯噪声）变换为目标数据分布。其核心优势在于：

- **训练目标更直接**：无需设计复杂的前向/反向过程调度表
- **采样速度更快**：可使用较少的 ODE 积分步数达到高质量生成
- **理论框架更统一**：将扩散模型、流模型等纳入同一数学体系

---

## 1. 问题设定

设数据空间为 $\mathcal{X} \subseteq \mathbb{R}^d$，目标数据分布为 $q(x)$。我们的目标是构造一个时间依赖的概率路径 $p_t(x)$，$t \in [0,1]$，满足边界条件：

$$p_0(x) = \pi(x), \quad p_1(x) = q(x)$$

其中 $\pi(x)$ 通常取标准高斯分布 $\mathcal{N}(0, I)$。

---

## 2. 条件流匹配 (Conditional Flow Matching)

### 2.1 基本思想

给定样本 $x_1 \sim q(x)$，定义从 $x_0 \sim \pi(x)$ 到 $x_1$ 的**条件插值路径**：

$$x_t = t \cdot x_1 + (1-t) \cdot x_0, \quad t \in [0,1]$$

这是一个简单的线性插值（Linear Interpolation / Convex Combination）。由此，条件概率路径的向量场 (Vector Field) 为：

$$v_t(x_t \mid x_1) = \frac{dx_t}{dt} = x_1 - x_0 = \frac{x_t - (1-t)x_0}{t}$$

当 $t > 0$ 时，可改写为：

$$\boxed{v_t(x_t \mid x_1) = \frac{x_1 - x_t}{1 - t}}$$

> **直觉理解**：向量场 $v_t$ 告诉我们"在时刻 $t$、位置 $x_t$ 处，应该朝哪个方向以多大速度移动才能到达真实数据 $x_1$"。

### 2.2 条件流匹配目标

对于给定的 $(x_1, t)$ 对，最优的条件向量场是确定性的。训练目标是让神经网络 $u_\theta(x, t)$ 近似这个条件向量场：

$$\mathcal{L}_{\text{CFM}}(\theta) = \mathbb{E}_{t, x_1, x_0} \left[ \| u_\theta(x_t, t) - v_t(x_t \mid x_1) \|^2 \right]$$

其中 $x_t = t x_1 + (1-t)x_0$，$t \sim \text{Uniform}[0,1]$，$x_1 \sim q(x)$，$x_0 \sim \pi(x)$。

---

## 3. 边缘流匹配 (Marginal Flow Matching)

### 3.1 关键问题：条件 vs 边缘

条件流匹配需要知道 $x_{1}$ 才能计算 $v_t(x_t \mid x_{1})$。但在**推理时**我们并不知道目标 $x_{1}$ 是什么！因此我们需要的是**边缘向量场** (Marginal Vector Field)：

$$v_t(x) = \mathbb{E}_{q(x_{1} \mid x_t)} [v_t(x \mid x_{1})]$$

即对给定位置 $x$ 在时刻 $t$，对所有可能的目标 $x_{1}$ 取期望。

### 3.2 核心定理：等价性

**定理 (Lipman et al., 2022)**：在**高斯先验 + 线性插值**条件下，条件流匹配损失与边缘流匹配损失**完全相等**：

$$\boxed{\mathcal{L}_{\text{CFM}}(\theta) = \mathcal{L}_{\text{MFM}}(\theta)}$$

其中边缘流匹配损失定义为：

$$\mathcal{L}_{\text{MFM}}(\theta) = \mathbb{E}_{t, p_t(x)} \left[ \| u_\theta(x, t) - v_t(x) \|^2 \right]$$

**证明思路**（关键步骤）：

1. 将条件损失展开：
   $$\mathcal{L}_{\text{CFM}} = \mathbb{E}_{t,x_1,x_0}\left[\|u_\theta - (x_1 - x_0)\|^2\right]$$

2. 注意到在线性插值下，$(x_t, x_1)$ 的联合分布关于 $x_0$ 和 $x_1$ **对称**（当 $\pi = \mathcal{N}(0,I)$ 时），使得条件期望恰好等于边缘期望。

3. 具体地，利用 $x_0 \perp x_1$ 以及 $x_t = tx_1 + (1-t)x_0$ 的结构，可以证明：
   $$\mathbb{E}_{x_0 \mid x_t,x_1}[x_0] = \frac{x_t - t x_1}{1-t}$$

4. 代入后得到 $\mathbb{E}[v_t(x_t \mid x_{1})] = v_t(x_t)$，从而两个损失函数相等。

> 这个等价性的重要性在于：**我们可以用容易采样的条件目标来训练，但学到的模型实际上收敛到边缘最优解**。

---

## 4. ODE 求解与采样

### 4.1 从向量场到概率路径

给定学习到的向量场 $u_\theta(x,t)$，通过求解 ODE 得到从噪声到数据的映射：

$$\frac{dz(t)}{dt} = u_\theta(z(t), t), \quad z(0) \sim \pi(x)$$

使用数值积分器（如 Euler 方法或 Runge-Kutta）：

$$z_{k+1} = z_k + \Delta t \cdot u_\theta(z_k, t_k), \quad \Delta t = \frac{1}{N}$$

其中 $N$ 为积分步数。

### 4.2 概率密度的演化

根据连续时间的变量变换公式 (Change of Variables)，概率密度沿 ODE 轨道的演化为：

$$\log p_t(z(t)) = \log p_0(z(0)) - \int_0^t \nabla \cdot u_\theta(z(s), s) \, ds$$

其中 $\nabla \cdot u_\theta$ 是向量场的散度 (Divergence)。这保证了概率质量守恒。

---

## 5. 与扩散模型的关系

### 5.1 扩散模型的视角

扩散模型的前向过程（VP-SDE）为：

$$dx = -\frac{1}{2}\beta(t) x \, dt + \sqrt{\beta(t)} \, dW$$

其对应的边缘概率路径为 $q_t(x) = \mathcal{N}(x; \alpha_t x_1, \sigma_t^2 I)$。

### 5.2 Flow Matching 统一框架

可以证明，**任何扩散模型都对应某个 Flow Matching 实例**。具体地，对于 VP-SDE，其向量场为：

$$v_t^{\text{diff}}(x) = -\frac{1}{2}\beta(t) x + \frac{1}{2}\beta(t) \cdot \mathbb{E}_{q(x_1 \mid x)}[x_1 \mid x_t = x]$$

而 Flow Matching 使用线性插值 $x_t = tx_1 + (1-t)x_0$，对应于一种特殊的"方差保持"路径。

### 5.3 为什么 Flow Matching 更灵活？

| 特性 | 扩散模型 | Flow Matching |
|------|---------|--------------|
| 路径设计 | 固定（由 SDE 决定） | 可自由选择 |
| 训练目标 | 需推导 $E[x_1 \mid x_t]$ 的闭式解 | 直接用 $(x_1-x_0)$ 作为目标 |
| 采样步数 | 通常需要 1000+ 步 | 可少至 10-50 步 |
| 理论分析 | 依赖随机微积分 | 基于 ODE，更直观 |

---

## 6. Rectified Flow: 改进方案

Liu et al. (2023) 提出的 Rectified Flow 是 Flow Matching 的重要改进。核心思想是用**直线 (Straight Line)** 插值代替曲线轨迹：

$$x_t = (1-t)x_0 + t x_1$$

并引入 **Reflow** 过程：用已训练的模型重新生成配对数据 $(x_0', x_1')$ 使得它们之间的轨迹更直，从而减少 ODE 积分误差：

$$x_0' = \text{ODESolve}(x_1; u_\theta, T=1 \to 0)$$

经过 $K$ 轮 Reflow 后，轨迹趋近于直线，此时仅需 **1 步 Euler 积分**即可完成生成！

---

## 7. 总结

Flow Matching 为生成建模提供了一个优雅且强大的数学框架：

$$
\begin{aligned}
&\textbf{核心流程} \\
&\text{1. 定义插值路径: } & x_t &= (1-t)x_0 + t x_1 \\
&\text{2. 向量场目标: } & v_t &= x_1 - x_0 \\
&\text{3. 训练网络: } & \min_\theta &\mathbb{E}[\|u_\theta(x_t,t) - v_t\|^2] \\
&\text{4. ODE 采样: } & \frac{dz}{dt} &= u_\theta(z,t)
\end{aligned}
$$

它不仅统一了扩散模型和流模型的理论基础，还催生了 Rectified Flow、Consistency Models 等一系列高效生成方法，是目前生成式 AI 领域最活跃的研究方向之一。

---

## 参考文献

- Lipman, Y., et al. (2022). *Flow Matching for Generative Modeling*. ICLR 2023.
- Liu, Q., et al. (2023). *Flow Straight and Fast: Learning to Generate and Transfer Data with Rectified Flow*. ICLR 2023.
- Albergo, M. S., & Vanden-Eijnden, E. (2022). *Building Normalizing Flows with Stochastic Interpolants*.
- Song, Y., et al. (2021). *Score-Based Generative Modeling through Stochastic Differential Equations*. ICLR 2021.
