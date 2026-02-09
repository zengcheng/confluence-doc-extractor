#!/usr/bin/env node
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const https = require("https");
const http = require("http");

const OUTPUT_DIR = path.join(process.cwd(), "docs");
const COOKIE_FILE = path.join(process.cwd(), ".cookies.json");
const CONCURRENCY = 5; // 并发下载数

let baseUrl = ""; // 从用户输入的链接中解析
let visited = new Set();
let docIndex = [];
let cookies = ""; // 登录后从浏览器提取的 cookie

/**
 * 从 Confluence 页面链接中解析出 baseUrl 和 pageId
 * 支持格式:
 *   https://wiki.example.com/pages/viewpage.action?pageId=123456
 *   https://wiki.example.com/display/SPACE/Page+Title
 *   纯数字 pageId（需要已设置 baseUrl）
 */
function parseConfluenceUrl(input) {
  // 纯数字 pageId
  if (/^\d+$/.test(input)) {
    if (!baseUrl) return null;
    return { baseUrl, pageId: input };
  }

  try {
    const url = new URL(input);
    const origin = url.origin; // e.g. https://wiki.example.com
    const params = url.searchParams;
    const pageId = params.get("pageId");
    if (pageId) {
      return { baseUrl: origin, pageId };
    }
  } catch (e) {
    // not a valid URL
  }

  return null;
}

/**
 * 从 baseUrl 推导出需要提取 cookie 的域名列表
 * 例如 https://kb.example.com → [https://kb.example.com, https://example.com]
 */
function getCookieDomains(url) {
  const parsed = new URL(url);
  const host = parsed.hostname; // e.g. kb.example.com
  const domains = [`${parsed.protocol}//${host}`];
  // 添加上级域名（去掉第一级子域名）
  const parts = host.split(".");
  if (parts.length > 2) {
    const parentDomain = parts.slice(1).join(".");
    domains.push(`${parsed.protocol}//${parentDomain}`);
  }
  return domains;
}

function askQuestion(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 尝试用已保存的 cookie 访问 API，验证是否仍然有效
 */
async function testCookieValid() {
  try {
    const buf = await httpGet(`${baseUrl}/rest/api/user/current`);
    const data = JSON.parse(buf.toString("utf-8"));
    return !!data.username;
  } catch (e) {
    return false;
  }
}

/**
 * 从本地文件加载 cookie
 */
function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
    cookies = saved.cookieString;
    if (saved.baseUrl) baseUrl = saved.baseUrl;
    console.log(`从 ${COOKIE_FILE} 加载了已保存的 cookie`);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 保存 cookie 到本地文件
 */
function saveCookies(browserCookies) {
  const data = {
    cookieString: browserCookies.map((c) => `${c.name}=${c.value}`).join("; "),
    baseUrl,
    savedAt: new Date().toISOString(),
    cookies: browserCookies,
  };
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2), "utf-8");
  console.log(`cookie 已保存到 ${COOKIE_FILE}\n`);
}

/**
 * 确保有有效的 cookie：先尝试复用本地，失效则打开浏览器登录
 */
async function ensureLogin() {
  if (!baseUrl) return; // 还没有 baseUrl，稍后在用户输入链接后再登录

  // 尝试加载本地 cookie
  if (loadCookies()) {
    console.log("验证 cookie 是否有效...");
    const valid = await testCookieValid();
    if (valid) {
      console.log("✅ cookie 仍然有效，跳过登录！\n");
      return;
    }
    console.log("⚠️ cookie 已失效，需要重新登录\n");
  }

  await browserLogin();
}

/**
 * 打开浏览器让用户手动登录
 */
async function browserLogin() {
  const browser = await chromium.launch({ headless: false, args: ["--start-maximized"] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  console.log("正在打开 Confluence 首页...");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("\n========================================");
  console.log("🔐 浏览器已打开，请在浏览器中完成登录。");
  console.log("   登录成功并看到知识库页面内容后，");
  console.log("   回到终端按【回车键】继续...");
  console.log("========================================\n");

  await askQuestion("👉 登录完成后请按回车键继续: ");

  const currentUrl = page.url();
  console.log(`\n当前页面: ${currentUrl}`);

  if (currentUrl.includes("login")) {
    console.log("⚠️ 看起来还在登录页面，请确认已完成登录。");
    await askQuestion("👉 确认登录完成后请再次按回车键: ");
  }

  // 从浏览器提取 cookie（包含所有相关域名）
  const cookieDomains = getCookieDomains(baseUrl);
  const browserCookies = await context.cookies(cookieDomains);
  cookies = browserCookies.map((c) => `${c.name}=${c.value}`).join("; ");
  console.log(`\n✅ 已提取 ${browserCookies.length} 个 cookie`);
  saveCookies(browserCookies);

  // 关闭浏览器，后续全部用 Node.js HTTP 请求
  await browser.close();
}

/**
 * 用 Node.js 原生 https 发起请求（携带 cookie），返回 Buffer
 */
function httpGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error("Too many redirects"));
    }
    const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;
    const parsedUrl = new URL(fullUrl);
    const mod = parsedUrl.protocol === "https:" ? https : http;
    const req = mod.get(fullUrl, { headers: { Cookie: cookies } }, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // 处理相对路径重定向
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith("http")) {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }
        return httpGet(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/**
 * 用 Node.js 发起 JSON API 请求，遇到 401/403 自动重新登录并重试一次
 */
async function apiGet(apiPath, retried = false) {
  try {
    const buf = await httpGet(`${baseUrl}${apiPath}`);
    return JSON.parse(buf.toString("utf-8"));
  } catch (e) {
    if (!retried && (e.message === "HTTP 401" || e.message === "HTTP 403")) {
      console.log("\n⚠️ cookie 已过期，正在重新登录...");
      await browserLogin();
      return apiGet(apiPath, true);
    }
    throw e;
  }
}

/**
 * 获取某个页面的所有直接子页面（支持分页）
 */
async function getChildPages(pageId) {
  const all = [];
  let start = 0;
  const limit = 200;
  while (true) {
    try {
      const data = await apiGet(
        `/rest/api/content/${pageId}/child/page?limit=${limit}&start=${start}&expand=title`
      );
      const results = data.results || [];
      for (const p of results) {
        all.push({ title: p.title, id: p.id });
      }
      if (results.length < limit) break;
      start += limit;
    } catch (e) {
      console.warn(`  ⚠️ API 获取子页面失败 (pageId=${pageId}): ${e.message}`);
      break;
    }
  }
  return all;
}

/**
 * 获取页面内容（通过 REST API，不需要浏览器导航）
 */
async function getPageContent(pageId) {
  try {
    const data = await apiGet(
      `/rest/api/content/${pageId}?expand=body.storage,version,history.createdBy`
    );
    return {
      title: data.title || "未知标题",
      htmlBody: data.body && data.body.storage ? data.body.storage.value : "",
      author:
        data.history && data.history.createdBy
          ? data.history.createdBy.displayName
          : "",
      lastModified: data.version ? data.version.when : "",
    };
  } catch (e) {
    console.warn(`  ⚠️ API 获取页面内容失败 (pageId=${pageId}): ${e.message}`);
    return null;
  }
}

/**
 * 获取页面附件列表
 */
async function getAttachments(pageId) {
  const all = [];
  let start = 0;
  const limit = 100;
  while (true) {
    try {
      const data = await apiGet(
        `/rest/api/content/${pageId}/child/attachment?limit=${limit}&start=${start}`
      );
      const results = data.results || [];
      for (const a of results) {
        all.push({
          title: a.title,
          downloadUrl:
            a._links && a._links.download ? a._links.download : null,
          mediaType:
            a.extensions && a.extensions.mediaType
              ? a.extensions.mediaType
              : "",
        });
      }
      if (results.length < limit) break;
      start += limit;
    } catch (e) {
      break;
    }
  }
  return all;
}

/**
 * 并发执行任务，限制并发数
 */
async function parallelLimit(tasks, limit) {
  const results = [];
  let i = 0;
  async function next() {
    const idx = i++;
    if (idx >= tasks.length) return;
    results[idx] = await tasks[idx]();
    await next();
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, tasks.length); w++) {
    workers.push(next());
  }
  await Promise.all(workers);
  return results;
}

/**
 * 下载文件到本地
 */
async function downloadFile(url, savePath) {
  try {
    const buf = await httpGet(url);
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(savePath, buf);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 将 Confluence storage format HTML 转为 Markdown
 */
function htmlToMarkdown(html) {
  // 简易 HTML 解析（不依赖浏览器 DOM）
  // 使用正则逐步替换
  let md = html;

  // 移除 CDATA、注释
  md = md.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  md = md.replace(/<!--[\s\S]*?-->/g, "");

  // 处理 Confluence 宏容器 - 提取内容
  md = md.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    "\n```\n$1\n```\n\n"
  );

  // 处理 draw.io 宏 - 转为图片引用（diagramName.png 是 Confluence 自动导出的附件）
  md = md.replace(
    /<ac:structured-macro[^>]*ac:name="drawio"[^>]*>[\s\S]*?<ac:parameter ac:name="diagramName">([^<]*)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/g,
    "\n![draw.io: $1]($1.png)\n\n"
  );

  // 移除其他 Confluence 宏标签但保留内容
  md = md.replace(/<ac:structured-macro[^>]*>|<\/ac:structured-macro>/g, "");
  md = md.replace(/<ac:rich-text-body>|<\/ac:rich-text-body>/g, "");
  md = md.replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, "");
  md = md.replace(/<ac:plain-text-body>[\s\S]*?<\/ac:plain-text-body>/g, "");

  // 处理图片 - Confluence 内嵌图片（ri:filename/ri:value 可能不是第一个属性）
  md = md.replace(
    /<ac:image[^>]*>\s*<ri:attachment[^>]*?ri:filename="([^"]*)"[^>]*\/>\s*<\/ac:image>/g,
    "![image]($1)"
  );
  md = md.replace(
    /<ac:image[^>]*>\s*<ri:url[^>]*?ri:value="([^"]*)"[^>]*\/>\s*<\/ac:image>/g,
    "![image]($1)"
  );

  // 处理 Confluence 链接
  md = md.replace(
    /<ac:link>\s*<ri:page\s+ri:content-title="([^"]*)"[^>]*\/>\s*(?:<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>\s*)?<\/ac:link>/g,
    (_, title, text) => `[${text || title}](${title})`
  );

  // 移除剩余 Confluence 特有标签
  md = md.replace(/<\/?ac:[^>]*>/g, "");
  md = md.replace(/<\/?ri:[^>]*>/g, "");

  // 标准 HTML 转 Markdown
  // 标题
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n\n");
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n\n");
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n\n");
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n\n");
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n\n");
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n\n");

  // 粗体、斜体
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");

  // 行内代码
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // 代码块
  md = md.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, content) => {
      // 去除内部的标签
      const clean = content.replace(/<[^>]*>/g, "");
      return `\n\`\`\`\n${clean}\n\`\`\`\n\n`;
    }
  );

  // 链接
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // 图片
  md = md.replace(
    /<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
    "![$2]($1)"
  );
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![image]($1)");

  // 表格
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
    const rows = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
      const cells = [];
      const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        const cellText = cellMatch[1]
          .replace(/<[^>]*>/g, "")
          .replace(/\|/g, "\\|")
          .replace(/\n+/g, " ")
          .trim();
        cells.push(cellText);
      }
      rows.push(cells);
    }
    if (rows.length === 0) return "";
    const colCount = Math.max(...rows.map((r) => r.length));
    rows.forEach((r) => {
      while (r.length < colCount) r.push("");
    });
    let result = "\n| " + rows[0].join(" | ") + " |\n";
    result += "| " + rows[0].map(() => "---").join(" | ") + " |\n";
    for (let i = 1; i < rows.length; i++) {
      result += "| " + rows[i].join(" | ") + " |\n";
    }
    return result + "\n";
  });

  // 列表
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    const items = [];
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(content)) !== null) {
      items.push("- " + liMatch[1].replace(/<[^>]*>/g, "").trim());
    }
    return "\n" + items.join("\n") + "\n\n";
  });

  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    const items = [];
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    let idx = 1;
    while ((liMatch = liRegex.exec(content)) !== null) {
      items.push(`${idx++}. ` + liMatch[1].replace(/<[^>]*>/g, "").trim());
    }
    return "\n" + items.join("\n") + "\n\n";
  });

  // 引用
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const clean = content.replace(/<[^>]*>/g, "").trim();
    return "\n" + clean.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
  });

  // 段落
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n\n");

  // 换行
  md = md.replace(/<br\s*\/?>/gi, "\n");

  // 水平线
  md = md.replace(/<hr\s*\/?>/gi, "\n---\n\n");

  // 移除所有剩余 HTML 标签
  md = md.replace(/<[^>]*>/g, "");

  // HTML 实体解码
  md = md.replace(/&amp;/g, "&");
  md = md.replace(/&lt;/g, "<");
  md = md.replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, " ");

  // 清理多余空行
  md = md.replace(/\n{3,}/g, "\n\n");

  return md.trim();
}

function sanitizeFilename(name) {
  return name
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

/**
 * 收集所有图片引用（从 Confluence storage HTML 中）
 */
function collectImageRefs(html) {
  const refs = [];
  const seen = new Set();

  // Confluence 内嵌附件图片: <ac:image><ri:attachment ri:filename="xxx"/></ac:image>
  const attachRegex = /<ac:image[^>]*>\s*<ri:attachment[^>]*?ri:filename="([^"]*)"[^>]*\/>/g;
  let m;
  while ((m = attachRegex.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      refs.push({ type: "attachment", filename: m[1] });
    }
  }

  // 外部 URL 图片: <ac:image><ri:url ri:value="xxx"/></ac:image>
  const urlRegex = /<ac:image[^>]*>\s*<ri:url[^>]*?ri:value="([^"]*)"[^>]*\/>/g;
  while ((m = urlRegex.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      refs.push({ type: "url", url: m[1] });
    }
  }

  // 标准 <img src="xxx">
  const imgRegex = /<img[^>]*src="([^"]*)"[^>]*\/?>/g;
  while ((m = imgRegex.exec(html)) !== null) {
    if (!seen.has(m[1]) && !m[1].startsWith("data:")) {
      seen.add(m[1]);
      refs.push({ type: "url", url: m[1] });
    }
  }

  // draw.io 宏: 对应的 PNG 导出附件名为 diagramName.png
  const drawioRegex = /<ac:structured-macro[^>]*ac:name="drawio"[^>]*>[\s\S]*?<ac:parameter ac:name="diagramName">([^<]*)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/g;
  while ((m = drawioRegex.exec(html)) !== null) {
    const pngName = m[1] + ".png";
    if (!seen.has(pngName)) {
      seen.add(pngName);
      refs.push({ type: "attachment", filename: pngName });
    }
  }

  return refs;
}

/**
 * 递归爬取页面及其子页面
 */
async function crawlPage(pageId, depth = 0, parentPath = "", outputBase = "") {
  if (visited.has(pageId)) return;
  visited.add(pageId);

  const indent = "  ".repeat(depth);
  console.log(`${indent}📄 正在提取 [pageId=${pageId}]`);

  // 通过 REST API 获取页面内容（不需要浏览器导航）
  const pageData = await getPageContent(pageId);
  if (!pageData || !pageData.title || pageData.title === "未知标题") {
    console.warn(`${indent}   ⚠️ 获取页面内容失败，跳过`);
    return;
  }

  console.log(`${indent}   标题: ${pageData.title}`);

  // 提前获取子页面列表，用于决定目录结构
  const childPages = await getChildPages(pageId);
  const hasChildren = childPages.length > 0;

  // 确定保存方式：
  //   根页面(depth=0) → 使用 parentPath 作为目录，内容保存为 title.md
  //   有子页面 → 创建子目录，内容保存为 title.md
  //   叶子页面 → 直接保存为 title.md 到父目录，资源共享父目录的 images/attachments
  const pageDirName = sanitizeFilename(pageData.title);

  let pageDir, filePath;
  // 所有资源（图片、附件）统一存放到根目录的 images/ 和 attachments/
  const base = outputBase || parentPath;
  const resourceDir = base;

  if (depth === 0) {
    pageDir = parentPath;
    filePath = path.join(pageDir, `${pageDirName}.md`);
  } else if (hasChildren) {
    // 有子页面 → 创建子目录
    let dirName = pageDirName;
    let counter = 1;
    while (fs.existsSync(path.join(parentPath, dirName))) {
      dirName = `${pageDirName}_${counter++}`;
    }
    pageDir = path.join(parentPath, dirName);
    filePath = path.join(pageDir, `${pageDirName}.md`);
  } else {
    // 叶子页面 → 保存为 .md 文件到父目录
    let mdName = `${pageDirName}.md`;
    let counter = 1;
    while (fs.existsSync(path.join(parentPath, mdName))) {
      mdName = `${pageDirName}_${counter++}.md`;
    }
    pageDir = parentPath;
    filePath = path.join(parentPath, mdName);
  }

  if (!fs.existsSync(pageDir)) {
    fs.mkdirSync(pageDir, { recursive: true });
  }

  // 所有非根页面的资源文件名加 pageId 前缀，防止不同页面的同名附件冲突
  const filePrefix = depth > 0 ? `${pageId}_` : "";

  // 计算 .md 文件到资源根目录的相对路径前缀（如 "../" 或 "../../"）
  const fileDir = path.dirname(filePath);
  const relToBase = path.relative(fileDir, resourceDir);
  // relToBase 为 "" 表示同级，否则为 ".." 或 "../.." 等
  const resPrefix = relToBase ? relToBase + "/" : "";

  // 获取附件列表
  const allAttachments = await getAttachments(pageId);

  // 建立附件文件名到下载 URL 的映射
  const attachmentMap = {};
  for (const att of allAttachments) {
    if (att.downloadUrl) {
      attachmentMap[att.title] = att.downloadUrl;
    }
  }

  // 收集图片引用
  const imageRefs = collectImageRefs(pageData.htmlBody);

  // 并行下载图片（存到 resourceDir/images/）
  const imgDir = path.join(resourceDir, "images");
  const imgPathMap = {}; // 原始引用 -> 本地路径
  if (imageRefs.length > 0) {
    const imgTasks = imageRefs.map((ref, i) => async () => {
      let downloadUrl;
      let fileName;

      if (ref.type === "attachment") {
        fileName = ref.filename;
        downloadUrl = attachmentMap[ref.filename];
        if (!downloadUrl) {
          downloadUrl = attachmentMap[decodeURIComponent(ref.filename)];
        }
        if (!downloadUrl) return;
      } else {
        downloadUrl = ref.url;
        try {
          fileName = path.basename(decodeURIComponent(ref.url.split("?")[0]));
        } catch (_) {
          fileName = `image_${i}.png`;
        }
      }

      const ext = path.extname(fileName) || ".png";
      const seq = String(i + 1).padStart(3, "0");
      let finalName = `${filePrefix}${seq}${ext}`;
      let counter = 1;
      while (fs.existsSync(path.join(imgDir, finalName))) {
        finalName = `${filePrefix}${seq}_${counter++}${ext}`;
      }

      const savePath = path.join(imgDir, finalName);
      const ok = await downloadFile(downloadUrl, savePath);
      if (ok) {
        if (ref.type === "attachment") {
          imgPathMap[ref.filename] = `${resPrefix}images/${finalName}`;
        } else {
          imgPathMap[ref.url] = `${resPrefix}images/${finalName}`;
        }
      }
    });

    await parallelLimit(imgTasks, CONCURRENCY);
    const downloadedCount = Object.keys(imgPathMap).length;
    if (downloadedCount > 0) {
      console.log(
        `${indent}   🖼️  下载了 ${downloadedCount}/${imageRefs.length} 张图片`
      );
    }
  }

  // 收集需要从末尾附件列表排除的文件名：已下载为内联图片的附件 + draw.io PNG 导出
  // 注意：draw.io 源文件（无扩展名或 .drawio）不排除，保留供高清导出
  const excludedAttachmentNames = new Set();
  // 排除已内联下载的图片附件
  for (const imgName of Object.keys(imgPathMap)) {
    excludedAttachmentNames.add(imgName);
  }
  // 解析 draw.io diagram 名称列表
  const drawioSrcRegex = /<ac:structured-macro[^>]*ac:name="drawio"[^>]*>[\s\S]*?<ac:parameter ac:name="diagramName">([^<]*)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/g;
  const drawioNames = new Set(); // draw.io 源文件名（无扩展名）
  let drawioMatch;
  while ((drawioMatch = drawioSrcRegex.exec(pageData.htmlBody)) !== null) {
    const diagramName = drawioMatch[1];
    drawioNames.add(diagramName);
    // 排除 draw.io PNG 导出（已内联为图片）
    excludedAttachmentNames.add(diagramName + ".png");
    // 确保 draw.io 源文件不被排除
    excludedAttachmentNames.delete(diagramName);
    excludedAttachmentNames.delete(diagramName + ".drawio");
  }
  // 下载剩余附件（排除已内联的图片和 draw.io PNG，保留 draw.io 源文件供高清导出）
  const remainingAttachments = allAttachments.filter(
    (a) => a.downloadUrl && !excludedAttachmentNames.has(a.title)
  );
  const downloadedAttachments = [];
  if (remainingAttachments.length > 0) {
    const attachDir = path.join(resourceDir, "attachments");
    const attTasks = remainingAttachments.map((att, i) => async () => {
      let ext = path.extname(att.title) || "";
      // draw.io 源文件：Confluence 中通常无扩展名，强制使用 .drawio 后缀
      if (!ext && drawioNames.has(att.title)) {
        ext = ".drawio";
      }
      const seq = String(i + 1).padStart(3, "0");
      let fileName = `${filePrefix}${seq}${ext}`;
      let counter = 1;
      while (fs.existsSync(path.join(attachDir, fileName))) {
        fileName = `${filePrefix}${seq}_${counter++}${ext}`;
      }
      const savePath = path.join(attachDir, fileName);
      const ok = await downloadFile(att.downloadUrl, savePath);
      if (ok) {
        downloadedAttachments.push({
          title: att.title,
          localPath: `${resPrefix}attachments/${fileName}`,
        });
      }
    });
    await parallelLimit(attTasks, CONCURRENCY);
    if (downloadedAttachments.length > 0) {
      console.log(
        `${indent}   📎 下载了 ${downloadedAttachments.length}/${remainingAttachments.length} 个附件`
      );
    }
  }

  // 将 HTML 转为 Markdown
  let mdBody = htmlToMarkdown(pageData.htmlBody);

  // 替换图片路径为本地路径
  for (const [ref, localPath] of Object.entries(imgPathMap)) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    mdBody = mdBody.replace(new RegExp(escaped, "g"), localPath);
  }

  // 构建最终 Markdown
  let mdContent = `# ${pageData.title}\n\n`;
  if (pageData.author || pageData.lastModified) {
    mdContent += `> `;
    if (pageData.author) mdContent += `作者: ${pageData.author} `;
    if (pageData.lastModified) mdContent += `| 最后修改: ${pageData.lastModified}`;
    mdContent += `\n\n`;
  }
  mdContent += `---\n\n`;
  mdContent += mdBody;

  if (downloadedAttachments.length > 0) {
    mdContent += `\n\n---\n\n## 附件\n\n`;
    for (const att of downloadedAttachments) {
      mdContent += `- [${att.title}](${att.localPath})\n`;
    }
  }
  mdContent += `\n`;

  // 保存
  fs.writeFileSync(filePath, mdContent, "utf-8");
  console.log(`${indent}   ✅ 已保存: ${path.relative(base, filePath)}`);

  docIndex.push({
    title: pageData.title,
    depth,
    filePath: path.relative(base, filePath),
    url: `${baseUrl}/pages/viewpage.action?pageId=${pageId}`,
  });

  // 递归处理子页面
  if (hasChildren) {
    console.log(`${indent}   📂 发现 ${childPages.length} 个子页面`);
    for (const child of childPages) {
      await crawlPage(child.id, depth + 1, pageDir, outputBase || parentPath);
    }
  }
}

function generateIndex(rootTitle, outputBase) {
  let indexContent = `# ${rootTitle} 文档目录\n\n`;
  indexContent += `> 提取时间: ${new Date().toLocaleString("zh-CN")}\n`;
  indexContent += `> 文档总数: ${docIndex.length}\n\n`;
  indexContent += `---\n\n`;

  for (const doc of docIndex) {
    const indent = "  ".repeat(doc.depth);
    const link = doc.filePath.replace(/ /g, "%20");
    indexContent += `${indent}- [${doc.title}](${link})\n`;
  }

  fs.writeFileSync(path.join(outputBase, "INDEX.md"), indexContent, "utf-8");
  console.log(`\n📋 目录索引已生成: ${path.relative(process.cwd(), path.join(outputBase, "INDEX.md"))}`);
}

/**
 * 通过 API 获取页面标题，验证 pageId 是否有效
 */
async function fetchPageTitle(pageId) {
  try {
    const data = await apiGet(`/rest/api/content/${pageId}?expand=title`);
    return data.title || null;
  } catch (e) {
    return null;
  }
}

/**
 * 提取一个 pageId 下的所有文档
 */
async function extractPage(pageId) {
  const title = await fetchPageTitle(pageId);
  if (!title) {
    console.log(`\n❌ 无法获取页面信息，请检查链接是否正确`);
    return;
  }

  console.log(`📄 页面标题: ${title}\n`);

  // 非交互模式（CLI 参数传入）跳过确认
  if (!cliInput) {
    const confirm = await askQuestion("确认提取该页面及其所有子页面？(Y/n): ");
    if (confirm.toLowerCase() === "n") {
      console.log("已取消。\n");
      return;
    }
  }

  // 重置状态
  visited = new Set();
  docIndex = [];

  const sanitizedTitle = sanitizeFilename(title);
  const outputBase = path.join(OUTPUT_DIR, sanitizedTitle);
  if (!fs.existsSync(outputBase)) {
    fs.mkdirSync(outputBase, { recursive: true });
  }

  console.log("========================================");
  console.log(`开始递归提取【${title}】下所有文档...`);
  console.log("（含图片和附件下载，使用 REST API 加速）");
  console.log("========================================\n");

  const startTime = Date.now();

  await crawlPage(pageId, 0, outputBase, outputBase);

  generateIndex(title, outputBase);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n========================================");
  console.log(`✅ 提取完成！共提取 ${docIndex.length} 篇文档`);
  console.log(`⏱️  耗时: ${elapsed} 秒`);
  console.log(`📁 文档保存在: ${outputBase}`);
  console.log("========================================\n");
}

// 解析命令行参数（支持完整链接或纯 pageId）
const cliInput = process.argv[2] || null;

/**
 * 处理用户输入（链接或 pageId），解析并确保登录，然后提取
 */
async function handleInput(input) {
  const parsed = parseConfluenceUrl(input);
  if (!parsed) {
    console.log("⚠️ 无法解析输入，请提供完整的 Confluence 页面链接");
    console.log("   示例: https://wiki.example.com/pages/viewpage.action?pageId=123456\n");
    return;
  }

  // 如果 baseUrl 变了（换了站点），需要重新登录
  if (baseUrl !== parsed.baseUrl) {
    baseUrl = parsed.baseUrl;
    cookies = "";
    console.log(`🔗 目标站点: ${baseUrl}`);
    await browserLogin();
  }

  console.log(`正在获取页面信息...`);
  await extractPage(parsed.pageId);
}

async function main() {
  console.log("\n========================================");
  console.log("  Confluence 文档提取工具");
  console.log("========================================\n");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 尝试从缓存恢复 baseUrl 和 cookie
  if (loadCookies() && baseUrl) {
    console.log("验证 cookie 是否有效...");
    const valid = await testCookieValid();
    if (valid) {
      console.log("✅ cookie 仍然有效，跳过登录！\n");
    } else {
      console.log("⚠️ cookie 已失效，将在输入链接后重新登录\n");
      baseUrl = "";
      cookies = "";
    }
  }

  // CLI 模式：直接处理传入的参数
  if (cliInput) {
    await handleInput(cliInput);
    return;
  }

  // 交互模式：循环提示输入链接
  while (true) {
    const input = await askQuestion("请输入 Confluence 页面链接（输入 q 退出）: ");
    if (input.toLowerCase() === "q") {
      console.log("再见！\n");
      break;
    }
    if (!input) {
      continue;
    }
    await handleInput(input);
  }
}

main().catch((err) => {
  console.error("❌ 发生错误:", err);
  process.exit(1);
});
