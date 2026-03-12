/**
 * 上传模块 —— 将本地 Markdown 文档上传到 Confluence
 * 参考 Python 版 upload_to_kb.py 实现
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { apiGet, apiPost, apiPut, uploadAttachment } = require("./api");
const { getBaseUrl } = require("./auth");
const { markdownToConfluence } = require("./converter/md-to-storage");

/**
 * 解析 YAML frontmatter
 * 简单实现，不依赖额外库
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const metadata = {};

  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    // 去掉引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    metadata[key] = value;
  }

  return { metadata, body };
}

/**
 * 从 Markdown 内容中提取页面标题
 * 优先使用第一个 # 标题，否则用文件名
 */
function extractTitle(mdBody, filePath) {
  for (const line of mdBody.split("\n")) {
    if (line.startsWith("# ")) {
      return line.substring(2).trim();
    }
  }
  return path.basename(filePath, ".md");
}

/**
 * 从 Markdown body 中移除用作页面标题的 # 标题行
 * 避免 Confluence 页面标题与正文 h1 重复
 */
function stripTitleFromBody(mdBody, title) {
  const lines = mdBody.split("\n");
  const idx = lines.findIndex(l => l.startsWith("# ") && l.substring(2).trim() === title);
  if (idx !== -1) {
    lines.splice(idx, 1);
    // 同时移除标题后紧跟的空行
    while (lines[idx] !== undefined && lines[idx].trim() === "") {
      lines.splice(idx, 1);
    }
  }
  return lines.join("\n");
}

/**
 * 获取页面信息
 */
async function getPageInfo(pageId) {
  return apiGet(`/rest/api/content/${pageId}?expand=space,version`);
}

/**
 * 查找同名子页面
 */
async function findChildPage(parentId, title) {
  const data = await apiGet(
    `/rest/api/content/${parentId}/child/page?limit=100&expand=version`
  );
  for (const page of (data.results || [])) {
    if (page.title === title) {
      return page;
    }
  }
  return null;
}

/**
 * 创建子页面
 */
async function createPage(spaceKey, parentId, title, contentHtml) {
  return apiPost("/rest/api/content", {
    type: "page",
    title,
    space: { key: spaceKey },
    ancestors: [{ id: parentId }],
    body: {
      storage: {
        value: contentHtml,
        representation: "storage",
      },
    },
  });
}

/**
 * 更新已有页面
 */
async function updatePage(pageId, title, contentHtml, version) {
  return apiPut(`/rest/api/content/${pageId}`, {
    type: "page",
    title,
    version: { number: version + 1 },
    body: {
      storage: {
        value: contentHtml,
        representation: "storage",
      },
    },
  });
}

/**
 * 上传一个 Markdown 文件到 Confluence
 * @param {string} filePath - Markdown 文件路径
 * @param {string} parentPageId - 父页面 ID
 * @param {object} options - 选项
 * @param {boolean} options.update - 是否更新已存在的同名页面
 * @returns {object} 上传结果
 */
async function uploadFile(filePath, parentPageId, options = {}) {
  const { update = false } = options;

  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const { metadata, body } = parseFrontmatter(content);

  // 确定标题
  const title = extractTitle(body, filePath);

  // 确定目标 pageId（从 frontmatter 中读取）
  const targetPageId = metadata.pageId || null;
  const targetSpaceKey = metadata.spaceKey || null;

  // 获取父页面信息
  const parentInfo = await getPageInfo(parentPageId);
  const spaceKey = targetSpaceKey || parentInfo.space.key;
  const parentTitle = parentInfo.title;
  console.log(`📁 父页面: [${parentTitle}] (space=${spaceKey})`);

  // 转换 Markdown → Confluence Storage Format（先移除标题行，避免与 KB 页面标题重复）
  const bodyWithoutTitle = stripTitleFromBody(body, title);
  let { html: contentHtml, mermaidImages } = await markdownToConfluence(bodyWithoutTitle);

  // 收集本地图片引用并替换为 Confluence 附件标签
  const mdDir = path.dirname(path.resolve(filePath));
  const localImages = collectLocalImages(contentHtml, mdDir);

  if (localImages.length > 0) {
    console.log(`  🖼️  发现 ${localImages.length} 个本地图片引用`);
    for (const img of localImages) {
      const escapedSrc = img.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const imgRegex = new RegExp(`<img[^>]*src="${escapedSrc}"[^>]*/?>`, "gi");
      const replacement = `<ac:image><ri:attachment ri:filename="${img.filename}" /></ac:image>`;
      contentHtml = contentHtml.replace(imgRegex, replacement);
    }
  }

  let pageId;

  if (targetPageId && update) {
    try {
      const existingInfo = await getPageInfo(targetPageId);
      const version = existingInfo.version.number;
      const result = await updatePage(targetPageId, title, contentHtml, version);
      pageId = result.id;
      console.log(`✅ 已更新: [${title}] (id=${pageId}, v${version + 1})`);
    } catch (e) {
      console.log(`⚠️ 无法更新 pageId=${targetPageId}: ${e.message}`);
      console.log("  将尝试在父页面下创建新页面...");
      const result = await createPage(spaceKey, parentPageId, title, contentHtml);
      pageId = result.id;
      console.log(`✅ 已创建: [${title}] (id=${pageId})`);
    }
  } else {
    const existing = await findChildPage(parentPageId, title);

    if (existing) {
      if (update) {
        const version = existing.version.number;
        const result = await updatePage(existing.id, title, contentHtml, version);
        pageId = result.id;
        console.log(`✅ 已更新: [${title}] (id=${pageId}, v${version + 1})`);
      } else {
        console.log(`⏭️  跳过（已存在）: [${title}] (id=${existing.id})`);
        return existing;
      }
    } else {
      const result = await createPage(spaceKey, parentPageId, title, contentHtml);
      pageId = result.id;
      console.log(`✅ 已创建: [${title}] (id=${pageId})`);
    }
  }

  // 查询页面已有附件名，用于跳过重复上传
  const existingAttNames = await getExistingAttachmentNames(pageId);

  // 上传本地图片作为附件（文件名与 KB 原始名一致，自动去重）
  if (localImages.length > 0) {
    const validImages = localImages.filter((img) => fs.existsSync(img.absolutePath));
    if (validImages.length > 0) {
      let uploaded = 0, skipped = 0;
      for (const img of validImages) {
        if (existingAttNames.has(img.filename)) {
          skipped++;
          continue;
        }
        try {
          await uploadAttachment(pageId, img.absolutePath, img.filename);
          uploaded++;
          console.log(`    ✅ ${img.filename}`);
        } catch (e) {
          console.log(`    ⚠️ ${img.filename} 上传失败: ${e.message}`);
        }
      }
      if (uploaded > 0 || skipped > 0) {
        console.log(`  📎 图片附件: ${uploaded} 个新上传, ${skipped} 个已存在跳过`);
      }
    }
  }

  // 上传 Mermaid 附件
  if (mermaidImages.length > 0) {
    console.log(`  📎 上传 ${mermaidImages.length} 个流程图附件...`);
    for (const { filename, data } of mermaidImages) {
      const tmpPath = path.join(os.tmpdir(), `kb_upload_${filename}`);
      try {
        fs.writeFileSync(tmpPath, data);
        await uploadAttachment(pageId, tmpPath, filename);
        console.log(`    ✅ ${filename}`);
      } catch (e) {
        console.log(`    ⚠️ ${filename} 上传失败: ${e.message}`);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }
  }

  const pageUrl = `${getBaseUrl()}/pages/viewpage.action?pageId=${pageId}`;
  console.log(`   🔗 ${pageUrl}`);

  return { id: pageId, title };
}

/**
 * 获取页面已有附件名列表
 */
async function getExistingAttachmentNames(pageId) {
  const names = new Set();
  try {
    const data = await apiGet(`/rest/api/content/${pageId}/child/attachment?limit=200`);
    for (const a of (data.results || [])) {
      names.add(a.title);
    }
  } catch (e) {
    // 查询失败不影响上传
  }
  return names;
}

/**
 * 收集 HTML 中引用的本地图片文件
 * @param {string} html - 已转换的 HTML
 * @param {string} mdDir - Markdown 文件所在目录（用于解析相对路径）
 * @returns {Array<{ src: string, filename: string, absolutePath: string }>}
 */
function collectLocalImages(html, mdDir) {
  const images = [];
  const seen = new Set();
  // 匹配 <img src="xxx" ... />
  const imgRegex = /<img[^>]*src="([^"]*)"[^>]*\/?>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    // 跳过远程 URL 和 data URI
    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) {
      continue;
    }
    if (seen.has(src)) continue;
    seen.add(src);

    const absolutePath = path.resolve(mdDir, src);
    const filename = path.basename(src);
    images.push({ src, filename, absolutePath });
  }
  return images;
}

module.exports = {
  uploadFile,
  parseFrontmatter,
};
