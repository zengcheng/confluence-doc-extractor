# Confluence 文档提取工具

从 Confluence 知识库递归提取文档，转换为 Markdown 格式并下载所有附件。支持任意 Confluence 实例。

## 功能

- 递归提取指定页面及其所有子页面
- 页面内容转换为 Markdown 格式（保留标题、表格、列表、代码块等）
- 下载所有附件（图片放 `images/`，其他附件放 `attachments/`）
- Markdown 中的图片引用自动替换为本地路径
- 生成 `INDEX.md` 目录索引
- Cookie 缓存，登录一次后续自动复用

## 快速使用（推荐）

不需要 clone 仓库，确保已安装 Node.js (>=16)，一行命令即可：

```bash
# 交互模式
npx git@github.com:zengcheng/confluence-doc-extractor.git

# 直接传入页面链接
npx git@github.com:zengcheng/confluence-doc-extractor.git "https://wiki.example.com/pages/viewpage.action?pageId=123456"
```

首次运行会自动安装依赖和 Chromium 浏览器。

## 本地安装

```bash
git clone git@github.com:zengcheng/confluence-doc-extractor.git
cd confluence-doc-extractor
npm install
```

## 使用

### 交互模式

```bash
node crawl.js
```

启动后会提示输入 Confluence 页面链接，首次使用会打开浏览器让你登录。可以连续提取多个页面，输入 `q` 退出。

### 命令行模式

```bash
node crawl.js "https://wiki.example.com/pages/viewpage.action?pageId=123456"
```

直接提取指定页面，适合脚本调用。

### 如何获取页面链接

打开 Confluence 页面，复制浏览器地址栏中的完整链接即可：

```
https://wiki.example.com/pages/viewpage.action?pageId=123456
```

## 输出结构

```
docs/
  页面标题/
    README.md           # 当前页面内容
    INDEX.md            # 目录索引
    images/             # 页面中引用的图片
    attachments/        # 其他附件（draw.io、Excel、PDF 等）
    子页面标题/
      README.md
      images/
      ...
```
