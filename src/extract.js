/**
 * 提取模块 —— 从 KB（Confluence）递归提取文档并转为 Markdown
 * 重构自 crawl.js，增加 YAML frontmatter 元数据
 */
const fs = require("fs");
const path = require("path");
const { sanitizeFilename, parallelLimit, downloadFile, formatDateTime } = require("./utils");
const { getBaseUrl } = require("./auth");
const { httpGet, apiGet } = require("./api");
const { htmlToMarkdown, collectImageRefs } = require("./converter/html-to-md");

const CONCURRENCY = 5;

let visited = new Set();
let docIndex = [];

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
 * 获取页面内容（含 spaceKey 和 version，用于 frontmatter）
 */
async function getPageContent(pageId) {
  try {
    const data = await apiGet(
      `/rest/api/content/${pageId}?expand=body.storage,version,space,history.createdBy`
    );
    return {
      title: data.title || "未知标题",
      htmlBody: data.body && data.body.storage ? data.body.storage.value : "",
      author:
        data.history && data.history.createdBy
          ? data.history.createdBy.displayName
          : "",
      lastModified: data.version ? data.version.when : "",
      version: data.version ? data.version.number : 1,
      spaceKey: data.space ? data.space.key : "",
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
          downloadUrl: a._links && a._links.download ? a._links.download : null,
          mediaType:
            a.extensions && a.extensions.mediaType ? a.extensions.mediaType : "",
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
 * 生成 YAML frontmatter
 */
function buildFrontmatter(pageId, pageData) {
  const baseUrl = getBaseUrl();
  const lines = [
    "---",
    `pageId: "${pageId}"`,
    `spaceKey: "${pageData.spaceKey}"`,
    `sourceUrl: "${baseUrl}/pages/viewpage.action?pageId=${pageId}"`,
    `title: "${pageData.title.replace(/"/g, '\\"')}"`,
    `author: "${(pageData.author || '').replace(/"/g, '\\"')}"`,
    `lastModified: "${formatDateTime(pageData.lastModified)}"`,
    `version: ${pageData.version}`,
    `extractedAt: "${formatDateTime(new Date().toISOString())}"`,
    "---",
    "",
  ];
  return lines.join("\n");
}

/**
 * 递归爬取页面及其子页面
 */
async function crawlPage(pageId, depth = 0, parentPath = "", outputBase = "") {
  if (visited.has(pageId)) return;
  visited.add(pageId);

  const baseUrl = getBaseUrl();
  const indent = "  ".repeat(depth);
  console.log(`${indent}📄 正在提取 [pageId=${pageId}]`);

  const pageData = await getPageContent(pageId);
  if (!pageData || !pageData.title || pageData.title === "未知标题") {
    console.warn(`${indent}   ⚠️ 获取页面内容失败，跳过`);
    return;
  }

  console.log(`${indent}   标题: ${pageData.title}`);

  const childPages = await getChildPages(pageId);
  const hasChildren = childPages.length > 0;

  const pageDirName = sanitizeFilename(pageData.title);

  let pageDir, filePath;
  const base = outputBase || parentPath;
  const resourceDir = base;

  if (depth === 0) {
    pageDir = parentPath;
    filePath = path.join(pageDir, `${pageDirName}.md`);
  } else if (hasChildren) {
    let dirName = pageDirName;
    let counter = 1;
    while (fs.existsSync(path.join(parentPath, dirName))) {
      dirName = `${pageDirName}_${counter++}`;
    }
    pageDir = path.join(parentPath, dirName);
    filePath = path.join(pageDir, `${pageDirName}.md`);
  } else {
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

  const fileDir = path.dirname(filePath);
  const relToBase = path.relative(fileDir, resourceDir);
  const resPrefix = relToBase ? relToBase + "/" : "";

  // 获取附件列表
  const allAttachments = await getAttachments(pageId);
  const attachmentMap = {};
  for (const att of allAttachments) {
    if (att.downloadUrl) {
      attachmentMap[att.title] = att.downloadUrl;
    }
  }

  // 收集图片引用
  const imageRefs = collectImageRefs(pageData.htmlBody);

  // 并行下载图片（保留原始文件名，按 pageId 分目录）
  const imgDir = path.join(resourceDir, "images", String(pageId));
  const imgPathMap = {};
  const usedImgNames = new Set();
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

      // 使用原始文件名（pageId 子目录已隔离，同名直接覆盖）
      let finalName = sanitizeFilename(fileName);
      if (usedImgNames.has(finalName)) {
        const ext = path.extname(finalName);
        const base = path.basename(finalName, ext);
        let counter = 1;
        while (usedImgNames.has(`${base}_${counter}${ext}`)) counter++;
        finalName = `${base}_${counter}${ext}`;
      }
      usedImgNames.add(finalName);

      const savePath = path.join(imgDir, finalName);
      const ok = await downloadFile(httpGet, downloadUrl, savePath);
      if (ok) {
        if (ref.type === "attachment") {
          imgPathMap[ref.filename] = `${resPrefix}images/${pageId}/${finalName}`;
        } else {
          imgPathMap[ref.url] = `${resPrefix}images/${pageId}/${finalName}`;
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

  // 处理附件排除逻辑
  const excludedAttachmentNames = new Set();
  for (const imgName of Object.keys(imgPathMap)) {
    excludedAttachmentNames.add(imgName);
  }

  const drawioSrcRegex = /<ac:structured-macro[^>]*ac:name="drawio"[^>]*>[\s\S]*?<ac:parameter ac:name="diagramName">([^<]*)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/g;
  const drawioNames = new Set();
  let drawioMatch;
  while ((drawioMatch = drawioSrcRegex.exec(pageData.htmlBody)) !== null) {
    const diagramName = drawioMatch[1];
    drawioNames.add(diagramName);
    excludedAttachmentNames.add(diagramName + ".png");
    excludedAttachmentNames.delete(diagramName);
    excludedAttachmentNames.delete(diagramName + ".drawio");
  }

  const remainingAttachments = allAttachments.filter(
    (a) => a.downloadUrl && !excludedAttachmentNames.has(a.title)
  );
  const downloadedAttachments = [];
  if (remainingAttachments.length > 0) {
    const attachDir = path.join(resourceDir, "attachments", String(pageId));
    const usedAttNames = new Set();
    const attTasks = remainingAttachments.map((att) => async () => {
      // 使用原始文件名
      let fileName = sanitizeFilename(att.title);
      let ext = path.extname(fileName) || "";
      if (!ext && drawioNames.has(att.title)) {
        fileName += ".drawio";
      }
      if (usedAttNames.has(fileName)) {
        const extPart = path.extname(fileName);
        const basePart = path.basename(fileName, extPart);
        let counter = 1;
        while (usedAttNames.has(`${basePart}_${counter}${extPart}`)) counter++;
        fileName = `${basePart}_${counter}${extPart}`;
      }
      usedAttNames.add(fileName);

      const savePath = path.join(attachDir, fileName);
      const ok = await downloadFile(httpGet, att.downloadUrl, savePath);
      if (ok) {
        downloadedAttachments.push({
          title: att.title,
          localPath: `${resPrefix}attachments/${pageId}/${fileName}`,
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

  // HTML → Markdown
  let mdBody = htmlToMarkdown(pageData.htmlBody);

  // 替换图片路径
  for (const [ref, localPath] of Object.entries(imgPathMap)) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    mdBody = mdBody.replace(new RegExp(escaped, "g"), localPath);
  }

  // 构建最终 Markdown —— 使用 YAML frontmatter
  let mdContent = buildFrontmatter(pageId, pageData);
  mdContent += `# ${pageData.title}\n\n`;
  mdContent += `---\n\n`;
  mdContent += mdBody;

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

/**
 * 生成目录索引
 */
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
 * 通过 spaceKey 和 title 查询 pageId
 */
async function resolvePageId(spaceKey, title) {
  try {
    const encodedTitle = encodeURIComponent(title);
    const data = await apiGet(
      `/rest/api/content?spaceKey=${spaceKey}&title=${encodedTitle}&limit=1`
    );
    if (data.results && data.results.length > 0) {
      return data.results[0].id;
    }
    return null;
  } catch (e) {
    console.warn(`⚠️ 根据 spaceKey=${spaceKey}, title=${title} 查询 pageId 失败: ${e.message}`);
    return null;
  }
}

/**
 * 通过 API 获取页面标题
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
 * @param {string} pageId
 * @param {boolean} skipConfirm - 是否跳过确认（CLI 模式下跳过）
 */
async function extractPage(pageId, skipConfirm = false) {
  const { askQuestion } = require("./utils");
  const OUTPUT_DIR = path.join(process.cwd(), "docs");

  const title = await fetchPageTitle(pageId);
  if (!title) {
    console.log(`\n❌ 无法获取页面信息，请检查链接是否正确`);
    return;
  }

  console.log(`📄 页面标题: ${title}\n`);

  if (!skipConfirm) {
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

/**
 * 解析 KB 链接
 */
function parseConfluenceUrl(input) {
  const baseUrl = getBaseUrl();

  if (/^\d+$/.test(input)) {
    if (!baseUrl) return null;
    return { baseUrl, pageId: input };
  }

  try {
    const url = new URL(input);
    const origin = url.origin;
    const params = url.searchParams;
    const pageId = params.get("pageId");
    if (pageId) {
      return { baseUrl: origin, pageId };
    }

    const displayMatch = url.pathname.match(/^\/display\/([^/]+)\/(.+)$/);
    if (displayMatch) {
      const spaceKey = decodeURIComponent(displayMatch[1]);
      const title = decodeURIComponent(displayMatch[2].replace(/\+/g, " "));
      return { baseUrl: origin, spaceKey, title };
    }
  } catch (e) {
    // not a valid URL
  }

  return null;
}

module.exports = {
  extractPage,
  parseConfluenceUrl,
  resolvePageId,
};
