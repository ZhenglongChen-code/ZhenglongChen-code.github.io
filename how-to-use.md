# 如何使用 GitHubHomePage 构建你的个人网站

本文档将指导你快速上手 GitHubHomePage 项目，并构建属于你自己的个人网站。

## 1. 项目概述

GitHubHomePage 是一个基于 Jekyll 的静态站点生成器，使用 TeXt 主题。它适用于个人或团队网站、博客、项目文档等。该模板提供了高度可定制、响应式、语义化 HTML 的网站构建解决方案。

## 2. 快速开始步骤

### 2.1 环境准备

在开始之前，确保你的系统已安装以下工具：

- Ruby 2.7+
- Node.js 12+
- Docker (可选，但推荐)
- Jekyll
- Git

### 2.2 克隆项目

```bash
git clone https://github.com/kitian616/jekyll-TeXt-theme.git
cd jekyll-TeXt-theme
```

### 2.3 安装依赖

```bash
bundle install
npm install
```

### 2.4 本地运行

```bash
npm run serve
```

然后在浏览器中访问 http://localhost:4000 查看网站。

## 3. 核心配置文件修改

要构建你自己的网站，需要修改以下核心文件：

### 3.1 _config.yml - 站点配置

这是最重要的配置文件，你需要修改以下内容：

```yaml
# 站点基本信息
title: 你的网站标题
description: > 
  你的网站描述

# 作者信息
author:
  type      : person
  name      : 你的名字
  url       : https://your-website.com
  avatar    : # 你的头像路径或URL
  bio       : 你的个人简介
  email     : your-email@example.com
  github    : your-github-username
  twitter   : your-twitter-username
  # 其他社交媒体信息...

# 皮肤和主题
text_skin: default # 可选: default, dark, forest, ocean, chocolate, orange
highlight_theme: default # 代码高亮主题

# 评论系统 (可选)
comments:
  provider: false # 可选: disqus, gitalk, valine

# 分享功能 (可选)
sharing:
  provider: false # 可选: addtoany, addthis

# 统计功能 (可选)
analytics:
  provider: false # 可选: google
```

### 3.2 _data/navigation.yml - 导航栏配置

修改导航栏链接：

```yaml
header:
  - titles:
      en      : Archive
      zh-Hans : 归档
    url: /archive.html

  - titles:
      en      : About
      zh-Hans : 关于
    url: /about.html

  # 添加你自己的页面链接
  - titles:
      en      : Projects
      zh-Hans : 项目
    url: /projects.html
```

### 3.3 about.md - 关于页面

修改此文件来创建你的个人介绍页面：

```markdown
---
layout: article
title: 关于我
---

在这里写你的个人介绍...
```

### 3.4 _posts/ 目录 - 博客文章

在 `_posts/` 目录中创建你的博客文章，文件名格式为：`YYYY-MM-DD-title.md`

示例文章：

```markdown
---
layout: article
title: 我的第一篇博客
tags: [博客, 技术]
---

文章内容...
```

## 4. 自定义内容

### 4.1 添加新页面

创建新的 Markdown 文件，例如 `projects.md`：

```markdown
---
layout: page
title: 我的项目
---

## 项目列表

在这里列出你的项目...
```

### 4.2 自定义样式

修改 `_sass/custom.scss` 文件来添加自定义样式：

```scss
// 自定义样式
.site-header {
  background-color: #your-color;
}
```

### 4.3 添加社交链接

在 `_config.yml` 的 `author` 部分添加你的社交媒体链接：

```yaml
author:
  github: your-github-username
  twitter: your-twitter-username
  linkedin: your-linkedin-username
  # 更多社交链接...
```

## 5. 部署网站

### 5.1 GitHub Pages 部署

1. 在 GitHub 上创建一个名为 `username.github.io` 的仓库
2. 将你的网站代码推送到该仓库
3. 在仓库设置中启用 GitHub Pages

### 5.2 Docker 部署

构建生产版本：

```bash
npm run docker-prod:build
npm run docker-prod:serve
```

## 6. 常用命令

```bash
# 本地开发
npm run serve

# 构建生产版本
npm run build

# Docker 开发
npm run docker-dev:dev

# Docker 生产部署
npm run docker-prod:build
npm run docker-prod:serve
```

## 7. 进阶定制

### 7.1 添加评论系统

在 `_config.yml` 中配置评论系统：

```yaml
comments:
  provider: gitalk
  gitalk:
    clientID: your-client-id
    clientSecret: your-client-secret
    repository: your-repo
    owner: your-username
    admin:
      - your-username
```

### 7.2 启用 Google Analytics

```yaml
analytics:
  provider: google
  google:
    tracking_id: your-tracking-id
```

### 7.3 启用文章点击量统计

```yaml
pageview:
  provider: leancloud
  leancloud:
    app_id: your-app-id
    app_key: your-app-key
    app_class: your-app-class
```

## 8. 故障排除

1. **Gem 依赖问题**：运行 `bundle install` 确保所有依赖已安装
2. **端口占用**：使用 `npm run serve -- --port 4001` 更改端口
3. **样式未生效**：检查 `_sass/` 目录中的 SCSS 文件是否有语法错误

通过以上步骤，你应该能够快速构建并部署属于你自己的个人网站。更多详细信息请参考项目的官方文档。