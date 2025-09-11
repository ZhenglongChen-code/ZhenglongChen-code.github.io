---
layout: article
titles:
  en: Blog
  zh-Hans: 博客
key: page-blogs
---

# 技术博客

欢迎来到我的技术博客！在这里我会分享一些技术心得、项目经验和学习笔记。

## 最新文章

{% for post in site.posts %}
- [{{ post.title }}]({{ post.url | relative_url }}) ({{ post.date | date: "%Y-%m-%d" }})
{% endfor %}

## 技术领域

我主要关注以下技术领域：

- 人工智能与机器学习
- 不确定性量化
- 油藏数值模拟
- 生成式AI
- 大模型技术（Prompt Engineering, Agent开发, 微调等）
- 云计算与运维自动化

## 热门话题

- [Jekyll网站开发](#)
- [神经算子方法](#)
- [自适应采样技术](#)
- [大模型微调实践](#)
- [MCP协议与Agent开发](#)

---

*博客内容持续更新中...*