/**
 * 公共工具函数
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

/**
 * 交互式命令行问答
 */
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
 * 清理文件名中的非法字符
 */
function sanitizeFilename(name) {
  return name
    .replace(/[\/\\:*?"<>|]/g, "_")
    .substring(0, 200);
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
async function downloadFile(httpGet, url, savePath) {
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
 * 格式化日期时间为 "YYYY-MM-DD HH:mm:ss"
 */
function formatDateTime(isoString) {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (e) {
    return isoString;
  }
}

module.exports = {
  askQuestion,
  sanitizeFilename,
  parallelLimit,
  downloadFile,
  formatDateTime,
};
