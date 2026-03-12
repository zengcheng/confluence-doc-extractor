/**
 * 统一认证模块
 * 支持两种认证方式：
 * 1. Cookie 模式 —— 通过 Playwright 浏览器登录获取
 * 2. Token 模式 —— 通过 KB_TOKEN 环境变量
 */
const fs = require("fs");
const path = require("path");
const { askQuestion } = require("./utils");

const COOKIE_FILE = path.join(process.cwd(), ".cookies.json");

// 认证状态
let authMode = null; // "cookie" | "token"
let cookies = "";
let token = "";
let baseUrl = "";

/**
 * 获取当前 baseUrl
 */
function getBaseUrl() {
  return baseUrl;
}

/**
 * 设置 baseUrl
 */
function setBaseUrl(url) {
  baseUrl = url;
}

/**
 * 获取认证头部
 */
function getAuthHeaders() {
  if (authMode === "token" && token) {
    return { Authorization: `Bearer ${token}` };
  }
  if (authMode === "cookie" && cookies) {
    return { Cookie: cookies };
  }
  // 默认返回空
  return {};
}

/**
 * 从 baseUrl 推导出需要提取 cookie 的域名列表
 */
function getCookieDomains(url) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const domains = [`${parsed.protocol}//${host}`];
  const parts = host.split(".");
  if (parts.length > 2) {
    const parentDomain = parts.slice(1).join(".");
    domains.push(`${parsed.protocol}//${parentDomain}`);
  }
  return domains;
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
    authMode = "cookie";
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
 * 通过 Playwright 打开浏览器让用户手动登录
 */
async function browserLogin() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: false, args: ["--start-maximized"] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  console.log("正在打开 KB 首页...");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("\n========================================");
  console.log("🔐 浏览器已打开，请在 KB 中完成登录。");
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

  const cookieDomains = getCookieDomains(baseUrl);
  const browserCookies = await context.cookies(cookieDomains);
  cookies = browserCookies.map((c) => `${c.name}=${c.value}`).join("; ");
  authMode = "cookie";
  console.log(`\n✅ 已提取 ${browserCookies.length} 个 cookie`);
  saveCookies(browserCookies);

  await browser.close();
}

/**
 * 尝试初始化 Token 认证（从环境变量）
 */
function tryInitToken() {
  const envToken = process.env.KB_TOKEN;
  if (envToken) {
    token = envToken;
    authMode = "token";
    console.log("✅ 使用 KB_TOKEN 环境变量进行认证");
    return true;
  }
  return false;
}

/**
 * 确保有有效的认证：
 * 1. 优先使用 Token 模式
 * 2. 其次尝试加载本地 Cookie
 * 3. 最后打开浏览器登录
 */
async function ensureLogin(testCookieValid) {
  if (!baseUrl) return;

  // 优先使用 Token
  if (tryInitToken()) return;

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
 * 重置认证状态（切换站点时使用）
 */
function resetAuth() {
  cookies = "";
  authMode = null;
}

module.exports = {
  getBaseUrl,
  setBaseUrl,
  getAuthHeaders,
  loadCookies,
  browserLogin,
  ensureLogin,
  tryInitToken,
  resetAuth,
};
