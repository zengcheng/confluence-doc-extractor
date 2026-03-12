---
name: kb-doc-sync
version: 2.0.0
author: zengcheng
description: KB（Confluence）知识库双向同步工具。支持从 KB 提取文档为 Markdown（pull），也支持将本地 Markdown 上传为 KB 页面（push）。当用户提到需要提取、导出、备份、上传、发布 KB 或 Confluence 文档时触发。用户也可以通过 /kb-doc-sync 显式调用。
---

# KB 知识库双向同步工具

从 KB（Confluence）提取文档为 Markdown，或将 Markdown 上传到 KB。适用于公司内部任意 Confluence 实例。

## 触发条件

当用户的意图符合以下场景时，应使用本 Skill：

- 用户提到需要「提取」「导出」「备份」「下载」KB 或 Confluence 文档 → 使用 **pull**
- 用户提到需要「上传」「发布」「推送」「同步」文档到 KB 或 Confluence → 使用 **push**
- 用户粘贴了 KB 页面链接
- 用户提到需要将 KB/Confluence 文档转换为 Markdown 格式
- 用户提到「KB」「知识库」「Confluence」等关键词

## 前置条件

- Node.js >= 16
- 首次运行会自动安装 Playwright 和 Chromium 浏览器（约 150MB）
- 认证方式（二选一）：
  - **Cookie 模式**：首次运行时通过浏览器登录（后续自动复用缓存）
  - **Token 模式**：设置 `KB_TOKEN` 环境变量（Bearer token）

## 使用方式

### Pull — 提取文档

```bash
# 通过 pageId 链接提取
npx git@github.com:zengcheng/confluence-doc-extractor.git pull "https://kb.cvte.com/pages/viewpage.action?pageId=123456"

# 通过 display 格式链接提取
npx git@github.com:zengcheng/confluence-doc-extractor.git pull "https://kb.cvte.com/display/SPACE/Page+Title"

# 交互模式
npx git@github.com:zengcheng/confluence-doc-extractor.git
```

### Push — 上传文档

```bash
# 上传 Markdown 到指定父页面下
npx git@github.com:zengcheng/confluence-doc-extractor.git push \
  --parent-page-id 540734829 \
  docs/my-doc.md

# 更新已有同名页面
npx git@github.com:zengcheng/confluence-doc-extractor.git push \
  --parent-page-id 540734829 \
  --update \
  docs/my-doc.md
```

### Push 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--parent-page-id` | ✅ | 父页面 ID |
| `--update` | ❌ | 同名页面已存在时更新内容 |
| `--base-url` | ❌ | KB 地址，默认 `https://kb.cvte.com` |

## 功能特性

### Pull（提取）
- **递归提取**：自动提取指定页面及其所有子页面
- **Markdown 转换**：将 Confluence storage format 转换为标准 Markdown
- **YAML Frontmatter**：自动保存 pageId、spaceKey、version 等同步元数据
- **附件下载**：图片存放 `images/`，其他附件存放 `attachments/`
- **目录索引**：生成 `INDEX.md`

### Push（上传）
- **Markdown → Confluence**：使用 marked 库转换，适配 Confluence Storage Format
- **智能更新**：读取 frontmatter 中的 pageId 自动更新对应页面
- **代码宏**：`<pre><code>` 自动转为 Confluence code 宏
- **Mermaid 渲染**：自动检测 mermaid 代码块，渲染为 PNG 上传为附件
- **目录宏**：`## 目录` 自动转为 Confluence TOC 宏

## 提取后的文档格式

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

> **说明**：frontmatter 中的元数据用于 push 时自动定位目标页面。修改文档内容后 push 即可更新远程页面。

## 输出结构

```
docs/
  页面标题/
    页面标题.md       # 当前页面内容（含 frontmatter）
    INDEX.md          # 目录索引
    images/           # 页面中引用的图片（按 pageId 分目录）
      {pageId}/
        image1.png
    attachments/      # 其他附件（按 pageId 分目录）
      {pageId}/
        file.pdf
    子页面标题/
      子页面标题.md
      ...
```

## 常见问题

### Cookie 失效怎么办？
工具会自动检测 Cookie 是否有效，失效时会自动打开浏览器让用户重新登录。

### 也可以使用 Token 认证
设置环境变量 `KB_TOKEN` 后，工具会优先使用 Token 认证，无需浏览器登录。
