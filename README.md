# KB 知识库双向同步工具

从 KB（Confluence）知识库提取文档为 Markdown，或将 Markdown 上传到 KB。支持任意 Confluence 实例。

## 功能

### Pull（提取）
- 递归提取指定页面及其所有子页面
- 页面内容转换为 Markdown 格式（保留标题、表格、列表、代码块等）
- 自动添加 YAML frontmatter 元数据（pageId、spaceKey、version 等）
- 下载所有附件（图片放 `images/`，其他附件放 `attachments/`）
- 生成 `INDEX.md` 目录索引
- Cookie 缓存，登录一次后续自动复用

### Push（上传）
- Markdown 转换为 Confluence Storage Format
- 支持从 frontmatter 读取 pageId 自动更新对应页面
- 代码块自动转为 Confluence code 宏
- Mermaid 流程图自动渲染为 PNG 上传为附件
- 目录自动转为 Confluence TOC 宏
- 支持创建新页面或更新已有页面

## 快速使用（推荐）

确保已安装 Node.js (>=16)：

```bash
# Pull — 提取文档
npx git@github.com:AcademicDog/confluence-doc-extractor.git pull "https://kb.example.com/pages/viewpage.action?pageId=123456"

# Push — 上传文档
npx git@github.com:AcademicDog/confluence-doc-extractor.git push --parent-page-id 123456 docs/my-doc.md

# 交互模式
npx git@github.com:AcademicDog/confluence-doc-extractor.git
```

> ⚠️ **首次运行说明**：首次运行会自动安装以下依赖：
> - **playwright** — 浏览器自动化库（用于首次登录获取 cookie）
> - **Chromium 浏览器** — 约 150MB
> - **marked** — Markdown 转 HTML 库（用于上传功能）

## 本地安装

```bash
git clone git@github.com:AcademicDog/confluence-doc-extractor.git
cd confluence-doc-extractor
npm install
```

## 使用

### Pull — 提取文档

```bash
# 命令行模式
node cli.js pull "https://kb.example.com/pages/viewpage.action?pageId=123456"
node cli.js pull "https://kb.example.com/display/SPACE/Page+Title"

# 交互模式
node cli.js
```

### Push — 上传文档

```bash
# 上传文件到指定父页面下
node cli.js push --parent-page-id 540734829 docs/my-doc.md

# 更新已有同名页面
node cli.js push --parent-page-id 540734829 --update docs/my-doc.md
```

### 认证方式

支持两种认证方式：

1. **Cookie 模式**（默认）：首次运行会打开浏览器让你登录，cookie 自动缓存复用
2. **Token 模式**：设置 `KB_TOKEN` 环境变量，无需浏览器登录

```bash
export KB_TOKEN="your-bearer-token"
node cli.js push --parent-page-id 123456 docs/my-doc.md
```

## 提取后的文档格式

提取的 Markdown 文件顶部包含 YAML frontmatter 元数据：

```markdown
---
pageId: "123456"
spaceKey: "ITKB"
sourceUrl: "https://kb.cvte.com/pages/viewpage.action?pageId=123456"
title: "页面标题"
author: "作者名"
lastModified: "2022-05-21 11:08:19"
version: 42
extractedAt: "2026-03-12 13:50:00"
---

# 页面标题

正文内容...
```

上传时会自动读取 frontmatter 中的 `pageId`，实现精准更新。

## 输出结构

```
docs/
  页面标题/
    页面标题.md       # 当前页面内容（含 frontmatter）
    INDEX.md          # 目录索引
    images/           # 图片（按 pageId 分目录）
      {pageId}/
        image1.png
    attachments/      # 其他附件（按 pageId 分目录）
      {pageId}/
        file.pdf
    子页面标题/
      子页面标题.md
      ...
```
