# KB 知识库双向同步工具

从 KB（Confluence）知识库提取文档为 Markdown，或将 Markdown 上传到 KB。支持任意 Confluence 实例。

## 功能

### Pull（下载）
- 递归提取指定页面及其所有子页面
- 页面内容转换为 Markdown 格式（保留标题、表格、列表、代码块等）
- 自动添加 YAML frontmatter 元数据（pageId、spaceKey、version 等）
- 下载所有附件（图片放 `images/{pageId}/`，其他附件放 `attachments/{pageId}/`）
- 生成 `INDEX.md` 目录索引
- Cookie 缓存，登录一次后续自动复用

### Push（上传）
- Markdown 转换为 Confluence Storage Format
- 支持从 frontmatter 读取 pageId 自动更新对应页面
- 支持本地新建 Markdown 直接创建为 KB 页面
- 代码块自动转为 Confluence code 宏
- Mermaid 流程图自动渲染为 PNG 上传为附件
- 目录自动转为 Confluence TOC 宏

## 快速开始

确保已安装 Node.js (>=16)：

```bash
git clone git@github.com:AcademicDog/confluence-doc-extractor.git
cd confluence-doc-extractor
npm install
```

> ⚠️ **首次运行说明**：`npm install` 会自动安装 Playwright 和 Chromium 浏览器（约 150MB），用于首次登录获取 cookie。

## 使用场景

### 场景一：下载 KB 文档到本地

从 KB 提取页面及其所有子页面为 Markdown，包含图片和附件。

```bash
# 通过 pageId 链接下载
node cli.js pull "https://kb.cvte.com/pages/viewpage.action?pageId=123456"

# 通过 display 格式链接下载
node cli.js pull "https://kb.cvte.com/display/SPACE/Page+Title"

# 交互模式（提示输入链接）
node cli.js
```

**下载后的文件结构**：

```
docs/
  页面标题/
    页面标题.md           # 页面内容（含 frontmatter 元数据）
    INDEX.md              # 目录索引
    images/{pageId}/      # 图片文件
    attachments/{pageId}/ # 其他附件
    子页面标题/
      子页面标题.md
```

**Markdown 文件格式**：

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

---

### 场景二：上传已有文档回 KB（更新同步）

将之前从 KB 下载的 Markdown 文档修改后，同步更新回原页面。工具会自动读取 frontmatter 中的 `pageId` 定位目标页面。

```bash
# 更新已有页面（通过 frontmatter 中的 pageId 自动定位）
node cli.js push --parent-page-id 123456 --update docs/页面标题/页面标题.md

# 批量上传多个文件
node cli.js push --parent-page-id 123456 --update docs/a.md docs/b.md docs/c.md
```

> 💡 `--parent-page-id` 是父页面 ID。`--update` 表示如果页面已存在则更新内容。

---

### 场景三：上传本地新建文档到 KB（创建新页面）

本地新建的 Markdown 文件（KB 上不存在），上传到指定父页面下创建为子页面。**不需要 frontmatter**，页面标题取自文件中第一个 `# 标题`。

```bash
# 在 pageId=123456 下创建新子页面
node cli.js push --parent-page-id 123456 docs/my-new-doc.md
```

**示例**：本地创建 `guide.md`：

```markdown
# 新手指引

这是一篇新的文档，将直接创建到 KB 中。

## 第一步

...
```

执行上传：

```bash
node cli.js push --parent-page-id 495131888 guide.md
```

结果：在 KB 的 `pageId=495131888` 页面下创建了名为「新手指引」的子页面。

> 💡 如果父页面下已有同名页面，且未加 `--update`，则会**跳过**。加上 `--update` 则会**覆盖更新**。

## 命令参考

### Pull 命令

```bash
node cli.js pull <url>
```

| 参数 | 说明 |
|------|------|
| `<url>` | KB 页面链接（支持 pageId 和 display 两种格式） |

### Push 命令

```bash
node cli.js push [options] <file1.md> [file2.md ...]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--parent-page-id <id>` | ✅ | 父页面 ID |
| `--update` | ❌ | 同名页面已存在时更新内容 |
| `--base-url <url>` | ❌ | KB 地址，默认 `https://kb.cvte.com` |

## 认证方式

支持两种认证方式：

1. **Cookie 模式**（默认）：首次运行会打开浏览器让你登录，cookie 自动缓存复用
2. **Token 模式**：设置 `KB_TOKEN` 环境变量，无需浏览器登录

```bash
export KB_TOKEN="your-bearer-token"
node cli.js push --parent-page-id 123456 docs/my-doc.md
```
