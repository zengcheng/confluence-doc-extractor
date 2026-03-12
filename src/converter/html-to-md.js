/**
 * Confluence Storage Format HTML → Markdown 转换器
 * 从 crawl.js 提取，无逻辑变更
 */

/**
 * 将 Confluence storage format HTML 转为 Markdown
 */
function htmlToMarkdown(html) {
  let md = html;

  // 移除 CDATA、注释
  md = md.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  md = md.replace(/<!--[\s\S]*?-->/g, "");

  // 处理 Confluence 宏容器 - 提取内容
  md = md.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    "\n```\n$1\n```\n\n"
  );

  // 处理 draw.io 宏
  md = md.replace(
    /<ac:structured-macro[^>]*ac:name="drawio"[^>]*>[\s\S]*?<ac:parameter ac:name="diagramName">([^<]*)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/g,
    "\n![draw.io: $1]($1.png)\n\n"
  );

  // 移除其他 Confluence 宏标签但保留内容
  md = md.replace(/<ac:structured-macro[^>]*>|<\/ac:structured-macro>/g, "");
  md = md.replace(/<ac:rich-text-body>|<\/ac:rich-text-body>/g, "");
  md = md.replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, "");
  md = md.replace(/<ac:plain-text-body>[\s\S]*?<\/ac:plain-text-body>/g, "");

  // 处理图片 - Confluence 内嵌图片
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
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
    const clean = content.replace(/<[^>]*>/g, "");
    return `\n\`\`\`\n${clean}\n\`\`\`\n\n`;
  });

  // 链接
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // 图片
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
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
    // 先将 <p>...</p> 转为独立段落，保留换行
    let inner = content
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .trim();
    return "\n" + inner.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
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

/**
 * 收集所有图片引用（从 Confluence storage HTML 中）
 */
function collectImageRefs(html) {
  const refs = [];
  const seen = new Set();

  // Confluence 内嵌附件图片
  const attachRegex = /<ac:image[^>]*>\s*<ri:attachment[^>]*?ri:filename="([^"]*)"[^>]*\/>/g;
  let m;
  while ((m = attachRegex.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      refs.push({ type: "attachment", filename: m[1] });
    }
  }

  // 外部 URL 图片
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

  // draw.io 宏
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

module.exports = {
  htmlToMarkdown,
  collectImageRefs,
};
