---
title: 数学公式渲染检查
description: 验证 Markdown 文章中的行内与块级 LaTeX 公式能够在静态构建时正确渲染。
date: 2026-07-23
tags: [工程, 数学]
language: zh
featured: false
draft: true
social:
  zhihu: false
  wechat: false
  xiaohongshu: false
---

这篇公开文章用于检查概率表达式 $p(y \mid x, I)$ 是否以行内公式显示。

下面的乘积形式应当作为独立公式渲染：

$$
p(y_{1:n} \mid x, I) = \prod_{t=1}^{n} p(y_t \mid y_{<t}, x, I)
$$
