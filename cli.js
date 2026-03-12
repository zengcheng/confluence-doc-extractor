#!/usr/bin/env node
/**
 * KB（Confluence）知识库双向同步工具 —— 统一 CLI 入口
 *
 * 用法：
 *   node cli.js pull "https://kb.example.com/pages/viewpage.action?pageId=123"
 *   node cli.js push --parent-page-id 123 docs/my-doc.md
 *   node cli.js                    # 交互模式（默认 pull）
 */
const fs = require("fs");
const path = require("path");
const { askQuestion } = require("./src/utils");
const { getBaseUrl, setBaseUrl, ensureLogin, loadCookies, resetAuth } = require("./src/auth");
const { testCookieValid } = require("./src/api");
const { extractPage, parseConfluenceUrl, resolvePageId } = require("./src/extract");
const { uploadFile } = require("./src/upload");

const OUTPUT_DIR = path.join(process.cwd(), "docs");

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
KB（Confluence）知识库双向同步工具

用法：
  node cli.js pull <url>                      从 KB 提取文档
  node cli.js push [options] <file...>        将 Markdown 上传到 KB
  node cli.js                                 交互模式

Pull 命令：
  node cli.js pull "https://kb.example.com/pages/viewpage.action?pageId=123"
  node cli.js pull "https://kb.example.com/display/SPACE/Page+Title"

Push 命令：
  node cli.js push --parent-page-id <id> [--update] <file1.md> [file2.md ...]

Push 选项：
  --parent-page-id <id>   父页面 ID（必填）
  --update                同名页面已存在时更新内容
  --base-url <url>        KB 地址，默认 https://kb.cvte.com

通用选项：
  --help, -h              显示帮助信息
`);
}

/**
 * 解析 push 命令的参数
 */
function parsePushArgs(args) {
  const result = {
    parentPageId: null,
    files: [],
    update: false,
    baseUrl: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--parent-page-id" && i + 1 < args.length) {
      result.parentPageId = args[++i];
    } else if (arg === "--update") {
      result.update = true;
    } else if (arg === "--base-url" && i + 1 < args.length) {
      result.baseUrl = args[++i];
    } else if (!arg.startsWith("--")) {
      result.files.push(arg);
    }
    i++;
  }

  return result;
}

/**
 * 尝试用已保存的 cookie 恢复认证
 */
async function tryCookieAuth() {
  if (loadCookies() && getBaseUrl()) {
    console.log("验证 cookie 是否有效...");
    const valid = await testCookieValid();
    if (valid) {
      console.log("✅ cookie 仍然有效，跳过登录！\n");
      return true;
    }
    console.log("⚠️ cookie 已失效，将在连接时重新登录\n");
    resetAuth();
  }
  return false;
}

/**
 * 处理 pull 输入
 */
async function handlePull(input, skipConfirm = false) {
  const parsed = parseConfluenceUrl(input);
  if (!parsed) {
    console.log("⚠️ 无法解析输入，请提供完整的 KB 页面链接");
    console.log("   示例:");
    console.log("   https://wiki.example.com/pages/viewpage.action?pageId=123456");
    console.log("   https://wiki.example.com/display/SPACE/Page+Title\n");
    return;
  }

  // 设置目标站点的 baseUrl
  if (getBaseUrl() !== parsed.baseUrl) {
    setBaseUrl(parsed.baseUrl);
    resetAuth();
    console.log(`🔗 目标站点: ${parsed.baseUrl}`);
  }

  // 确保有有效认证（自动处理 cookie 失效 → 浏览器登录）
  await ensureLogin(testCookieValid);

  // 如果没有 pageId，通过 spaceKey + title 查询
  let pageId = parsed.pageId;
  if (!pageId && parsed.spaceKey && parsed.title) {
    console.log(`🔍 正在通过空间(${parsed.spaceKey})和标题(${parsed.title})查询 pageId...`);
    pageId = await resolvePageId(parsed.spaceKey, parsed.title);
    if (!pageId) {
      console.log("❌ 未找到对应的页面，请检查链接是否正确\n");
      return;
    }
    console.log(`✅ 找到 pageId: ${pageId}`);
  }

  console.log(`正在获取页面信息...`);
  await extractPage(pageId, skipConfirm);
}

/**
 * 处理 push 命令
 */
async function handlePush(pushArgs) {
  if (!pushArgs.parentPageId) {
    console.log("❌ 缺少 --parent-page-id 参数");
    console.log("   用法: node cli.js push --parent-page-id <id> <file.md>");
    return;
  }

  if (pushArgs.files.length === 0) {
    console.log("❌ 缺少要上传的文件");
    console.log("   用法: node cli.js push --parent-page-id <id> <file.md>");
    return;
  }

  // 设置 baseUrl
  if (pushArgs.baseUrl) {
    setBaseUrl(pushArgs.baseUrl);
  } else if (!getBaseUrl()) {
    setBaseUrl("https://kb.cvte.com");
  }

  // 确保登录
  await ensureLogin(testCookieValid);

  const results = [];
  for (const f of pushArgs.files) {
    try {
      console.log(`\n📤 上传: ${f}`);
      const result = await uploadFile(f, pushArgs.parentPageId, {
        update: pushArgs.update,
      });
      results.push({ file: f, status: "ok", pageId: result.id });
    } catch (e) {
      console.log(`❌ 上传失败 [${f}]: ${e.message}`);
      results.push({ file: f, status: "error", error: e.message });
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  const okCount = results.filter((r) => r.status === "ok").length;
  console.log(`上传完成: ${okCount}/${results.length} 成功`);
}

/**
 * 主入口
 */
async function main() {
  const args = process.argv.slice(2);

  // 帮助信息
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  console.log("\n========================================");
  console.log("  KB（Confluence）知识库双向同步工具");
  console.log("========================================\n");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const command = args[0];

  if (command === "pull") {
    // Pull 模式
    const url = args[1];
    if (!url) {
      console.log("❌ 缺少页面链接");
      console.log("   用法: node cli.js pull <url>");
      return;
    }

    await handlePull(url, true);

  } else if (command === "push") {
    // Push 模式
    const pushArgs = parsePushArgs(args.slice(1));
    await handlePush(pushArgs);

  } else if (command && !command.startsWith("-")) {
    // 兼容旧用法：直接传入 URL（等同于 pull）
    await handlePull(command, true);

  } else {
    // 交互模式
    if (await tryCookieAuth()) {
      // cookie 有效
    } else if (getBaseUrl()) {
      console.log("⚠️ cookie 已失效，将在输入链接后重新登录\n");
      setBaseUrl("");
    }

    while (true) {
      const input = await askQuestion("请输入 KB 页面链接（输入 q 退出）: ");
      if (input.toLowerCase() === "q") {
        console.log("再见！\n");
        break;
      }
      if (!input) continue;
      await handlePull(input);
    }
  }
}

main().catch((err) => {
  console.error("❌ 发生错误:", err);
  process.exit(1);
});
