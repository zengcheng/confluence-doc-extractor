/**
 * Markdown → Confluence Storage Format 转换器
 * 参考 Python 版 upload_to_kb.py 的 markdown_to_confluence() 实现
 * 使用 marked 库将 Markdown 转为 HTML，再适配 Confluence 格式
 */
const https = require("https");
const http = require("http");

let marked;

/**
 * 确保 marked 库已加载
 */
function ensureMarked() {
  if (!marked) {
    try {
      marked = require("marked");
    } catch (e) {
      throw new Error(
        "缺少 marked 依赖，请运行: npm install marked"
      );
    }
  }
}

/**
 * 渲染 Mermaid 代码为 PNG（通过 kroki.io），返回 Buffer 或 null
 */
async function renderMermaid(code) {
  // 尝试 kroki.io
  try {
    const png = await httpPostBuffer("https://kroki.io/mermaid/png", code, {
      "Content-Type": "text/plain",
    });
    return png;
  } catch (e) {
    console.log(`  ⚠️ kroki.io 渲染失败: ${e.message}`);
  }

  // 备用：mermaid.ink
  try {
    const encoded = Buffer.from(code, "utf-8").toString("base64url");
    const url = `https://mermaid.ink/img/${encoded}`;
    const png = await httpGetBuffer(url);
    return png;
  } catch (e2) {
    console.log(`  ⚠️ mermaid.ink 也失败: ${e2.message}`);
  }

  return null;
}

/**
 * 简单的 HTTP GET（返回 Buffer）
 */
function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * 简单的 HTTP POST（返回 Buffer）
 */
function httpPostBuffer(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === "https:" ? https : http;
    const data = Buffer.from(body, "utf-8");

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": data.length,
      },
      timeout: 15000,
    };

    const req = mod.request(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * 将 Markdown 转换为 Confluence Storage Format
 * @param {string} mdContent - Markdown 内容（不含 frontmatter）
 * @returns {{ html: string, mermaidImages: Array<{ filename: string, data: Buffer }> }}
 */
async function markdownToConfluence(mdContent) {
  ensureMarked();

  const mermaidImages = [];
  let mermaidCounter = 0;

  // Step 1: 预处理 - 提取 mermaid 代码块，用占位符替代
  const mermaidBlocks = {};
  mdContent = mdContent.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => {
    mermaidCounter++;
    const key = `__MERMAID_${mermaidCounter}__`;
    mermaidBlocks[key] = code;
    return `\`\`\`\n${key}\n\`\`\``;
  });

  // Step 2: 预处理 - 替换 ## 目录 + 链接列表为占位符
  const lines = mdContent.split("\n");
  const outLines = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "## 目录") {
      outLines.push("__CONFLUENCE_TOC__");
      i++;
      while (i < lines.length && (lines[i].startsWith("- [") || lines[i].trim() === "")) {
        i++;
      }
      continue;
    }
    outLines.push(lines[i]);
    i++;
  }
  mdContent = outLines.join("\n");

  // Step 3: 用 marked 转换为 HTML
  let html = marked.parse(mdContent);

  // Step 4: 后处理 - 替换代码块为 Confluence 宏
  // 处理带语言的代码块
  html = await replaceAsync(
    html,
    /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
    async (match, lang, code) => {
      // 检查是否是 mermaid 占位符
      for (const [key, mermaidCode] of Object.entries(mermaidBlocks)) {
        if (code.includes(key)) {
          const idxMatch = key.match(/__MERMAID_(\d+)__/);
          if (!idxMatch) continue;
          const idx = parseInt(idxMatch[1]);
          const fname = `mermaid_${idx}.png`;
          console.log(`  🎨 渲染 Mermaid 流程图 #${idx}...`);
          const pngData = await renderMermaid(mermaidCode);
          if (pngData) {
            mermaidImages.push({ filename: fname, data: pngData });
            return (
              `<ac:image ac:width="800">` +
              `<ri:attachment ri:filename="${fname}" />` +
              `</ac:image>`
            );
          }
        }
      }

      return (
        `<ac:structured-macro ac:name="code">` +
        `<ac:parameter ac:name="language">${lang}</ac:parameter>` +
        `<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body>` +
        `</ac:structured-macro>`
      );
    }
  );

  // 处理无语言的代码块
  html = await replaceAsync(
    html,
    /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    async (match, code) => {
      // 检查是否是 mermaid 占位符
      for (const [key, mermaidCode] of Object.entries(mermaidBlocks)) {
        if (code.includes(key)) {
          const idxMatch = key.match(/__MERMAID_(\d+)__/);
          if (!idxMatch) continue;
          const idx = parseInt(idxMatch[1]);
          const fname = `mermaid_${idx}.png`;
          console.log(`  🎨 渲染 Mermaid 流程图 #${idx}...`);
          const pngData = await renderMermaid(mermaidCode);
          if (pngData) {
            mermaidImages.push({ filename: fname, data: pngData });
            return (
              `<ac:image ac:width="800">` +
              `<ri:attachment ri:filename="${fname}" />` +
              `</ac:image>`
            );
          }
        }
      }

      return (
        `<ac:structured-macro ac:name="code">` +
        `<ac:parameter ac:name="language">text</ac:parameter>` +
        `<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body>` +
        `</ac:structured-macro>`
      );
    }
  );

  // Step 5: 替换 TOC 占位符
  html = html.replace(
    "<p>__CONFLUENCE_TOC__</p>",
    '<ac:structured-macro ac:name="toc">' +
    '<ac:parameter ac:name="maxLevel">3</ac:parameter>' +
    "</ac:structured-macro>"
  );

  // Step 6: 还原 CDATA 块中被 marked 转义的 HTML 实体
  html = html.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    (_, content) => {
      const restored = content
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
      return `<![CDATA[${restored}]]>`;
    }
  );

  // Step 7: XHTML 兼容处理
  // Confluence Storage Format 要求严格 XHTML，void 元素必须自闭合
  // 先统一处理为自闭合，再清理可能产生的双斜杠
  html = html.replace(/<img([^>]*?)>/gi, "<img$1 />");
  html = html.replace(/<br\s*>/gi, "<br />");
  html = html.replace(/<hr\s*>/gi, "<hr />");
  html = html.replace(/<input([^>]*?)>/gi, "<input$1 />");
  // 清理可能产生的 " /  />" → " />"
  html = html.replace(/\s*\/\s*\/\s*>/g, " />");

  // Step 7.5: blockquote 内换行处理
  // marked 会把多行 > 引用合并为一个 <p> 标签，但 Confluence 需要每行独立 <p>
  html = html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    // 将 <p> 内的换行拆成多个 <p> 标签
    const processed = inner.replace(/<p>([\s\S]*?)<\/p>/gi, (__, pContent) => {
      const lines = pContent.split("\n").filter(l => l.trim());
      if (lines.length <= 1) return `<p>${pContent}</p>`;
      return lines.map(l => `<p>${l.trim()}</p>`).join("");
    });
    return `<blockquote>${processed}</blockquote>`;
  });

  // Step 8: 移除 Confluence 不支持的 emoji 和补充平面字符
  // Confluence 对 4 字节 UTF-8 字符（U+10000 以上）会报 "Unsupported character" 错误
  html = html.replace(/[\u{10000}-\u{1FFFF}]/gu, "");
  html = html.replace(/[\u{2600}-\u{27BF}]/gu, "");

  return { html, mermaidImages };
}

/**
 * 支持异步替换的 String.replace
 */
async function replaceAsync(str, regex, asyncFn) {
  const promises = [];
  str.replace(regex, (match, ...args) => {
    promises.push(asyncFn(match, ...args));
    return match;
  });
  const results = await Promise.all(promises);
  let i = 0;
  return str.replace(regex, () => results[i++]);
}

module.exports = {
  markdownToConfluence,
};
