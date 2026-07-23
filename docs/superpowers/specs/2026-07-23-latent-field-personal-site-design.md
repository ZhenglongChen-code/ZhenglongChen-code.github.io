# Latent Field 个人网站设计规格

## 1. 产品目标

将现有 Jekyll 学术主页升级为一个长期维护的个人品牌网站，用于展示 Zhenglong Chen 作为 VLM Algorithm Engineer 的研究、项目、论文与技术写作。

网站首先服务于长期内容积累与专业形象展示，而不是短期求职落地页。第一阶段保持纯静态架构，优先保证加载速度、阅读体验、内容可维护性和部署灵活性。

成功标准：

- 桌面端与移动端均具备清晰、优雅且有技术感的阅读体验。
- 首页能够快速传达个人身份、研究方向、代表项目和最新文章。
- Markdown 文章完整支持行内与块级 LaTeX 公式。
- 文章可以导出为适合微信公众号、知乎和小红书手动发布的版本。
- 网站可在本地稳定运行并完成生产构建；部署在本地验收后另行实施。

## 2. 实现基线与复用策略

实现不从零开始。主要复用以下参考项目：

`/Users/bytedance/Documents/Codex/2026-07-22/xian-z/.worktrees/personal-site`

优先复用：

- Astro 项目结构、静态构建配置与固定端口 `3002`。
- Content Collections 的文章与项目模型。
- 首页、文章列表、文章详情、标签、RSS、404 与中英文文章路由。
- Markdown 内容校验、草稿过滤和翻译关联逻辑。
- 知乎 Markdown、微信公众号 HTML、小红书文案导出流程。
- Vitest、站点产物检查和构建脚本。
- 已验证的部署脚本与服务器配置作为后续部署参考，但第一阶段不执行部署。

现有 Jekyll 仓库中的头像、简历、个人经历、奖项、项目和联系方式继续作为内容来源。迁移时保留真实信息，不凭空增加论文、项目或任职经历。

## 3. 品牌与视觉方向

品牌名称：`LATENT FIELD`

左上角副标识：`ZHENGLONG CHEN · RESEARCH NOTES`

首页主要身份：`Zhenglong Chen — VLM Algorithm Engineer`

采用已确认的 A 方案「Paper Index」暖色编辑部技术风：

- 背景采用温暖纸张色，基准为 `#F3EFE6`。
- 正文采用近黑墨色，基准为 `#181815`。
- 主强调色使用钴蓝 `#1649C2`，用于身份、链接和少量导航状态。
- 次强调色使用朱红 `#B53325`，用于索引号、重点标记和品牌细节。
- 英文标题采用优雅衬线字体栈；导航、标签和元信息使用精确的无衬线或等宽字体。
- 桌面端采用不对称编辑网格、索引行和细分隔线，不使用通用三卡片布局。
- 移动端收敛为单栏，保证标题、公式、代码块和导航不溢出。
- 动效限于首屏轻量出现、链接下划线和行项目位移；支持 `prefers-reduced-motion`。
- 完成页面后使用 `impeccable-design-polish` 做一次去模板感、层级、响应式和无障碍检查。

## 4. 信息架构

全站导航使用英文：

`Home / Research / Projects / Articles / About`

文章标题和正文可使用中文或英文。

公开页面：

```text
/
├── Hero：身份、研究宣言与主要入口
├── Selected Research
├── Selected Projects
└── Latest Articles

/research
├── 研究方向
├── 论文与成果
└── 研究条目详情或外部链接

/projects
└── 项目列表与项目详情

/articles
├── 标签筛选
└── /articles/[slug]

/en/articles/[slug]
/about
/tags/[tag]
/rss.xml
/404.html
```

`Research` 与 `Projects` 分开：前者展示研究方向、论文、方法与成果，后者展示可运行系统、AI 工具和工程实践。

## 5. 首页设计

首屏采用左右不对称布局：

- 左侧为 `VLM ALGORITHM ENGINEER`、大型姓名字标和品牌索引信息。
- 右侧为简洁研究宣言，覆盖 multimodal learning、mathematical thinking 与 AI products。
- 首屏不使用装饰性大图，排版、网格和色彩构成主要视觉表达。

首屏之后：

1. `Selected Research & Projects` 使用索引列表展示类型、标题、摘要、标签和年份。
2. `Latest Articles` 突出一篇精选文章，并展示日期、阅读时间、摘要和公式片段。
3. 页脚提供 GitHub、Email、Zhihu、WeChat 与后续可扩展的 X 链接。

## 6. 内容模型

文章使用 Astro Content Collections 管理，核心字段：

```yaml
title: 从视觉表征到多模态推理
description: 文章摘要
date: 2026-07-23
updated: 2026-07-23
tags:
  - VLM
  - Reasoning
language: zh
translation: visual-reasoning-en
featured: true
draft: false
social:
  zhihu: true
  wechat: true
  xiaohongshu: true
```

规则：

- `language` 只允许 `zh` 或 `en`。
- 稳定 URL 使用英文 slug，标题变化不改变链接。
- `draft: true` 的文章不进入公开页面、RSS 或社交平台导出。
- 翻译关联存在时必须指向另一语言的公开文章。
- 日期按亚洲/上海时区解释并输出标准日期。
- 项目和研究条目分别使用独立集合，避免页面组件承担内容解析职责。

## 7. Markdown、LaTeX 与代码

- Markdown 同时支持 `$...$` 行内公式与 `$$...$$` 块级公式。
- 使用构建期 KaTeX 渲染，避免文章打开后才闪烁或依赖大型客户端运行时。
- 公式过宽时提供横向滚动，不缩小到不可阅读。
- 代码块支持语法高亮、语言标签、复制按钮和移动端横向滚动。
- 标题自动生成稳定锚点，文章详情页提供目录与阅读进度提示。

## 8. 多平台手动发布辅助

第一阶段只生成平台适配稿，不登录第三方账号，也不自动发布。

导出目录：

```text
social_exports/
└── [article_slug]/
    ├── zhihu.md
    ├── wechat.html
    └── xiaohongshu.md
```

转换规则：

- 知乎版保留 Markdown 标题、列表、引用、代码和可兼容的公式表达，并附主站原文链接。
- 微信公众号版生成带内联样式的 HTML，便于复制到编辑器并减少样式丢失。
- 小红书版生成短标题、精简正文、话题建议和原文提示，不自动生成图片卡片。
- 各平台导出可在文章元数据中独立关闭。
- 导出失败只阻止该次导出或生产构建，不修改文章源文件。

自动登录和一键发布作为后续独立阶段，需要针对平台授权、风控和发布 API 单独设计。

## 9. 响应式、无障碍与性能

- 语义化 HTML，保留跳转到主要内容的链接。
- 所有交互元素具备可见的键盘焦点状态。
- 正文、元信息和强调色满足可读对比度。
- 导航在小屏幕下变为紧凑菜单，同时保留键盘和触摸操作。
- 避免首屏大图和非必要客户端 JavaScript。
- 内容列表较长时使用 CSS `content-visibility` 等渐进式优化，但不牺牲可访问性。
- 页面动效只使用 `transform` 与 `opacity`，并提供减少动态效果回退。

## 10. 失败处理

- 内容字段、翻译关系、日期或 slug 不合法时终止构建并输出明确错误。
- 公式解析失败时定位到文章和源文件行，避免静默输出错误公式。
- 导出器不能支持某种 Markdown 结构时保留原始内容并给出警告，不擅自删除段落。
- 缺失外部链接或可选社交账号不会阻止页面渲染。
- 部署不属于第一阶段；本地验收失败时不进行任何远端写入。

## 11. 验证策略

自动验证：

- Content Collections 字段、日期、slug、草稿和翻译关联测试。
- Markdown 行内公式、块级公式、代码块和标题锚点测试。
- 首页、Research、Projects、Articles、About、标签、RSS 和 404 静态产物检查。
- 三个平台导出产物的关键结构测试。
- Astro 类型检查与生产构建。

人工验证：

- 桌面端和移动端的首屏、导航、研究列表、文章正文、公式与代码块。
- 键盘导航、焦点状态、减少动态效果和颜色对比度。
- 将三个平台适配稿分别粘贴到目标平台编辑器预览。

## 12. 第一阶段交付边界

包含：Astro 静态站、内容迁移、品牌视觉、研究与项目页面、Markdown/LaTeX 文章、多平台导出、本地开发与生产构建验证。

不包含：第三方平台自动登录与发布、数据库、CMS、评论系统、账号系统、域名切换和远端部署。服务器或 GitHub Pages 发布在本地验收通过后单独执行。
