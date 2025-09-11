# 部署到 GitHub Pages 指南

## 准备工作

1. 确保你已经有一个名为 `username.github.io` 的 GitHub 仓库（其中 username 是你的 GitHub 用户名）
2. 确保本地项目已经与远程仓库关联

## 部署步骤

### 方法一：直接推送到 GitHub Pages（推荐）

GitHub Pages 原生支持 Jekyll，因此你可以直接推送 Jekyll 项目到仓库，GitHub 会自动构建和部署。

1. 提交所有更改到 Git：
   ```bash
   git add .
   git commit -m "Prepare for GitHub Pages deployment"
   ```

2. 推送到 GitHub：
   ```bash
   git push origin master
   ```

3. 在 GitHub 仓库中启用 GitHub Pages：
   - 访问你的仓库页面
   - 点击 "Settings" 选项卡
   - 向下滚动到 "Pages" 部分
   - 在 "Source" 下选择 "Deploy from a branch"
   - 选择分支（通常是 master 或 main）和文件夹（通常是 /root）
   - 点击 "Save"

### 方法二：预构建静态文件并推送

如果你希望预构建静态文件再推送，可以使用以下步骤：

1. 构建静态文件：
   ```bash
   npm run build
   ```
   或使用 Jekyll 命令：
   ```bash
   bundle exec jekyll build
   ```

2. 这将在 `_site` 目录中生成静态文件

3. 提交并推送到 GitHub

## 配置说明

在 `_config.yml` 文件中，你可能需要更新以下配置：

```yaml
url: "https://username.github.io"
baseurl: ""
```

其中 `username` 是你的 GitHub 用户名。

## 自定义域名（可选）

如果你想使用自定义域名：

1. 在仓库根目录创建一个名为 `CNAME` 的文件
2. 在该文件中添加你的自定义域名，例如：
   ```
   yourdomain.com
   ```
3. 在你的域名提供商处添加相应的 DNS 记录

## 注意事项

1. GitHub Pages 使用 `gh-pages` 分支或 `master` 分支（对于 username.github.io 仓库）来部署网站
2. 构建过程可能需要几分钟时间完成
3. 你可以通过访问 `https://username.github.io` 来查看你的网站
4. 如果遇到问题，可以在仓库的 "Settings" -> "Pages" 部分查看构建日志

## 故障排除

- 如果网站没有正确显示，请检查 `_config.yml` 中的 `url` 和 `baseurl` 配置
- 确保你的仓库名称是 `username.github.io`
- 检查 GitHub Pages 是否已正确启用