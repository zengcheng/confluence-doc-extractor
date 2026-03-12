/**
 * Confluence REST API 统一封装
 */
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { getBaseUrl, getAuthHeaders, browserLogin } = require("./auth");

/**
 * 用 Node.js 原生 HTTP 发起请求，返回 Buffer
 */
function httpGet(url, redirectCount = 0) {
  const baseUrl = getBaseUrl();
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error("Too many redirects"));
    }
    const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;
    const parsedUrl = new URL(fullUrl);
    const mod = parsedUrl.protocol === "https:" ? https : http;
    const headers = getAuthHeaders();
    const req = mod.get(fullUrl, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
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
 * 用 Node.js 原生 HTTP 发起 POST/PUT 请求，返回 Buffer
 */
function httpRequest(url, method, body, extraHeaders = {}) {
  const baseUrl = getBaseUrl();
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;
    const parsedUrl = new URL(fullUrl);
    const mod = parsedUrl.protocol === "https:" ? https : http;
    const authHeaders = getAuthHeaders();
    const headers = { ...authHeaders, ...extraHeaders };

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers,
    };

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          const errMsg = buf.toString("utf-8").substring(0, 500);
          return reject(new Error(`HTTP ${res.statusCode}: ${errMsg}`));
        }
        resolve(buf);
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * 上传 multipart 表单数据（用于附件上传）
 */
function httpUploadMultipart(url, filePath, filename) {
  const baseUrl = getBaseUrl();
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;
    const parsedUrl = new URL(fullUrl);
    const mod = parsedUrl.protocol === "https:" ? https : http;
    const authHeaders = getAuthHeaders();

    const boundary = `----FormBoundary${Date.now()}`;
    const fileData = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".drawio": "application/xml",
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";

    const prefix = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuf = Buffer.concat([prefix, fileData, suffix]);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        ...authHeaders,
        "X-Atlassian-Token": "nocheck",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuf.length,
      },
    };

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          const errMsg = buf.toString("utf-8").substring(0, 500);
          return reject(new Error(`HTTP ${res.statusCode}: ${errMsg}`));
        }
        try {
          resolve(JSON.parse(buf.toString("utf-8")));
        } catch (_) {
          resolve({});
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    req.write(bodyBuf);
    req.end();
  });
}

/**
 * JSON API GET 请求，401/403 时自动重新登录
 */
async function apiGet(apiPath, retried = false) {
  const baseUrl = getBaseUrl();
  try {
    const buf = await httpGet(`${baseUrl}${apiPath}`);
    return JSON.parse(buf.toString("utf-8"));
  } catch (e) {
    if (!retried && (e.message === "HTTP 401" || e.message === "HTTP 403")) {
      console.log("\n⚠️ 认证已过期，正在重新登录...");
      await browserLogin();
      return apiGet(apiPath, true);
    }
    throw e;
  }
}

/**
 * JSON API POST 请求
 */
async function apiPost(apiPath, data) {
  const baseUrl = getBaseUrl();
  const body = JSON.stringify(data);
  const buf = await httpRequest(`${baseUrl}${apiPath}`, "POST", body, {
    "Content-Type": "application/json",
  });
  return JSON.parse(buf.toString("utf-8"));
}

/**
 * JSON API PUT 请求
 */
async function apiPut(apiPath, data) {
  const baseUrl = getBaseUrl();
  const body = JSON.stringify(data);
  const buf = await httpRequest(`${baseUrl}${apiPath}`, "PUT", body, {
    "Content-Type": "application/json",
  });
  return JSON.parse(buf.toString("utf-8"));
}

/**
 * 上传附件到指定页面
 */
async function uploadAttachment(pageId, filePath, filename) {
  const url = `/rest/api/content/${pageId}/child/attachment`;

  // 检查是否已存在同名附件
  let existingId = null;
  try {
    const checkData = await apiGet(`${url}?filename=${encodeURIComponent(filename)}`);
    const results = checkData.results || [];
    if (results.length > 0) {
      existingId = results[0].id;
    }
  } catch (e) {
    // 忽略检查失败
  }

  const baseUrl = getBaseUrl();
  if (existingId) {
    return httpUploadMultipart(`${baseUrl}${url}/${existingId}/data`, filePath, filename);
  } else {
    return httpUploadMultipart(`${baseUrl}${url}`, filePath, filename);
  }
}

/**
 * 验证 cookie 是否有效
 */
async function testCookieValid() {
  try {
    const buf = await httpGet(`${getBaseUrl()}/rest/api/user/current`);
    const data = JSON.parse(buf.toString("utf-8"));
    return !!data.username;
  } catch (e) {
    return false;
  }
}

module.exports = {
  httpGet,
  httpRequest,
  apiGet,
  apiPost,
  apiPut,
  uploadAttachment,
  testCookieValid,
};
