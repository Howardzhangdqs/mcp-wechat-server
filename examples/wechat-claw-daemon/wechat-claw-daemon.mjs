#!/usr/bin/env bun

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, copyFile, mkdir, readFile, writeFile, unlink, readdir, rename as fsRename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { constants as fsConstants } from "node:fs";

const execFileAsync = promisify(execFile);

const BUNX_PATH = process.env.WECHAT_BUNX_PATH || "/Users/miyin/.bun/bin/bunx";
const BUN_PATH = process.env.WECHAT_BUN_PATH || "/Users/miyin/.bun/bin/bun";
const OPENCLAW_PATH =
  process.env.WECHAT_OPENCLAW_PATH || "/Users/miyin/.nvm/versions/node/v24.13.0/bin/openclaw";
const MCP_LOCAL_ENTRY =
  process.env.WECHAT_MCP_ENTRY || "/Users/miyin/study/wechatbot/mcp-wechat-server-src/package/src/index.ts";
const MCP_MODE = process.env.WECHAT_MCP_MODE || "local";
const WAKE_WORD = process.env.WECHAT_WAKE_WORD || "你好claw";
const SLEEP_WORD = process.env.WECHAT_SLEEP_WORD || "再见claw";
const SHUTDOWN_WORD = process.env.WECHAT_SHUTDOWN_WORD || "彻底下线";

const PHOTOS_LIBRARY_PATH = path.join(os.homedir(), "Pictures", "Photos Library.photoslibrary");
const PHOTOS_ORIGINALS_PATH = path.join(PHOTOS_LIBRARY_PATH, "originals");
const PHOTOS_EXPORT_BASE = path.join(os.homedir(), "Pictures", "photo_exports");
const PHOTOS_MANAGED_DIR = path.join(os.homedir(), "Pictures", "claw_photos_managed");
const WECHAT_INBOX_DIR = path.join(os.homedir(), ".mcp-wechat-server", "inbox_images");

const STATE_DIR = path.join(os.homedir(), ".mcp-wechat-server");
const STATE_FILE = path.join(STATE_DIR, "wake-daemon-state.json");

function now() {
  return new Date().toISOString();
}

function log(message, extra = "") {
  const line = `[${now()}] ${message}${extra ? ` ${extra}` : ""}`;
  console.log(line);
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      awake: typeof parsed.awake === "boolean" ? parsed.awake : true,
      lastSender: typeof parsed.lastSender === "string" ? parsed.lastSender : null,
      lastImages:
        parsed.lastImages && typeof parsed.lastImages === "object" && !Array.isArray(parsed.lastImages)
          ? parsed.lastImages
          : {},
      pendingImages:
        parsed.pendingImages && typeof parsed.pendingImages === "object" && !Array.isArray(parsed.pendingImages)
          ? parsed.pendingImages
          : {},
      updatedAt: parsed.updatedAt || now(),
    };
  } catch {
    return {
      awake: true,
      lastSender: null,
      lastImages: {},
      pendingImages: {},
      updatedAt: now(),
    };
  }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    STATE_FILE,
    JSON.stringify(
      {
        awake: state.awake,
        lastSender: state.lastSender,
        lastImages: state.lastImages ?? {},
        pendingImages: state.pendingImages ?? {},
        updatedAt: now(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function parseToolResult(result) {
  const text = result?.content?.find?.((item) => item?.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return parseToolResult(result);
}

async function generateReplyFromOpenClaw(inputText) {
  const { stdout } = await execFileAsync(OPENCLAW_PATH, ["agent", "--agent", "main", "--message", inputText], {
    timeout: 240000,
    maxBuffer: 1024 * 1024,
  });

  const reply = stdout.trim();
  if (!reply) {
    return "我收到了，但这次没生成内容。你可以换个说法再试一次。";
  }

  if (reply.length > 1800) {
    return `${reply.slice(0, 1800)}\n\n（内容较长，已截断）`;
  }

  return reply;
}

async function sendNaturalReply(client, to, context) {
  try {
    const text = await generateReplyFromOpenClaw(
      [
        "你是微信聊天助手。",
        "请把下面信息转成自然口语回复，像真人微信聊天，不要模板标题，不要项目符号，控制在1-3句。",
        `信息：${context}`,
      ].join("\n"),
    );
    await callTool(client, "send_text_message", { to, text });
  } catch {
    await callTool(client, "send_text_message", { to, text: context.slice(0, 500) });
  }
}

async function analyzeImageConversation(imagePath, userMessage) {
  const prompt = [
    "你是用户的微信AI助手，语气要像朋友聊天，不像客服或报告。",
    `请基于这张本地图片回答用户问题：${imagePath}`,
    `用户消息：${userMessage || "请先整体描述这张图"}`,
    "回答风格必须贴近这条规则：先一句直接判断，再用1-2句说明你为什么这么看，最后可选补一句‘要不要我继续做X’。",
    "禁止模板腔：不要出现‘直接答案/依据/不确定项/总结/结论如下’等标题词。",
    "格式要求：纯文本，不要加粗，不要编号，不要项目符号，不要分节标题。",
    "长度要求：优先 2-4 句，像微信对话一样自然。",
    "如果问题涉及推断人物性格、身份、动机等高不确定内容，语气要克制：只说可见线索+可能性，不下绝对结论。",
  ].join("\n");
  return await generateReplyFromOpenClaw(prompt);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function formatTimestampForDir(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parsePhotoExportCount(text) {
  const match = text.match(/^照片导出最新\s*(\d{1,2})$/);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count)) return null;
  return Math.max(1, Math.min(count, 50));
}

async function getNewestPhotoFilesFromDir(dirPath, count) {
  const cmd = `find ${shellQuote(dirPath)} -type f -print0 | xargs -0 stat -f '%m\\t%N' | sort -nr | head -n ${count} | cut -f2-`;
  const { stdout } = await execFileAsync("/bin/zsh", ["-lc", cmd], {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parsePhotoSyncCount(text) {
  const match = text.match(/^照片同步最新\s*(\d{1,2})$/);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count)) return null;
  return Math.max(1, Math.min(count, 50));
}

function buildInboundImagePath(messageId, ext = "jpg") {
  const safeExt = /^[a-zA-Z0-9]{1,6}$/.test(ext) ? ext : "jpg";
  return path.join(WECHAT_INBOX_DIR, `wechat-inbound-${messageId ?? Date.now()}.${safeExt}`);
}

function extractJsonObject(text) {
  const raw = (text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}

  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }

  return null;
}

async function routeIntentByAI(input) {
  const prompt = [
    "你是消息意图路由器。只输出 JSON，不要解释。",
    "intent 可选: chat | shutdown | analyze_pending_image | save_pending_image | cancel_pending_image | rename_managed_image | photo_status | photo_stats | photo_sync_latest | photo_export_latest",
    '返回格式: {"intent":"...","params":{"filename":null,"from_name":null,"to_name":null,"count":null}}',
    "规则: count 仅 sync/export 使用，范围 1-50；不确定就 intent=chat。",
    `上下文: has_pending_image=${input.hasPendingImage}, has_last_saved_image=${input.hasLastSavedImage}`,
    `用户消息: ${input.text}`,
  ].join("\n");

  const raw = await generateReplyFromOpenClaw(prompt);
  const parsed = extractJsonObject(raw);
  const allowed = new Set([
    "chat",
    "shutdown",
    "analyze_pending_image",
    "save_pending_image",
    "cancel_pending_image",
    "rename_managed_image",
    "photo_status",
    "photo_stats",
    "photo_sync_latest",
    "photo_export_latest",
  ]);

  if (!parsed || typeof parsed !== "object" || !allowed.has(parsed.intent)) {
    return { intent: "chat", params: {} };
  }

  const p = typeof parsed.params === "object" && parsed.params ? parsed.params : {};
  const countRaw = Number(p.count);
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(50, Math.floor(countRaw))) : null;

  return {
    intent: parsed.intent,
    params: {
      filename: typeof p.filename === "string" ? p.filename : null,
      from_name: typeof p.from_name === "string" ? p.from_name : null,
      to_name: typeof p.to_name === "string" ? p.to_name : null,
      count,
    },
  };
}

async function findManagedImagePathByBase(base) {
  const target = sanitizeFileBaseName(base);
  if (!target) return null;

  await mkdir(PHOTOS_MANAGED_DIR, { recursive: true });
  const entries = await readdir(PHOTOS_MANAGED_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  const exact = files.find((name) => path.parse(name).name === target);
  if (exact) return path.join(PHOTOS_MANAGED_DIR, exact);

  const fuzzy = files.find((name) => path.parse(name).name.startsWith(target));
  if (fuzzy) return path.join(PHOTOS_MANAGED_DIR, fuzzy);

  return null;
}

function sanitizeFileBaseName(name) {
  const safe = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim();

  return safe || null;
}

async function makeUniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 1;
  while (true) {
    try {
      await access(candidate, fsConstants.F_OK);
      candidate = path.join(dir, `${base}-${i}${ext}`);
      i += 1;
    } catch {
      return candidate;
    }
  }
}

async function handlePhotoCommand(text) {
  if (text === "照片帮助") {
    return [
      "📷 照片命令：",
      "1) 照片状态",
      "2) 照片统计",
      "3) 照片同步最新 10（从系统照片库复制到管理目录）",
      "4) 照片导出最新 10（从管理目录导出）",
      "",
      "说明：管理目录为 ~/Pictures/claw_photos_managed，不会直接修改 Photos 库。",
    ].join("\n");
  }

  if (text === "照片状态") {
    await mkdir(PHOTOS_MANAGED_DIR, { recursive: true });
    let libraryReadable = false;
    let originalsReadable = false;
    let managedReadable = false;
    let managedWritable = false;
    try {
      await access(PHOTOS_LIBRARY_PATH, fsConstants.R_OK);
      libraryReadable = true;
    } catch {
      libraryReadable = false;
    }

    try {
      await access(PHOTOS_ORIGINALS_PATH, fsConstants.R_OK);
      originalsReadable = true;
    } catch {
      originalsReadable = false;
    }

    try {
      await access(PHOTOS_MANAGED_DIR, fsConstants.R_OK);
      managedReadable = true;
    } catch {
      managedReadable = false;
    }

    try {
      await access(PHOTOS_MANAGED_DIR, fsConstants.W_OK);
      managedWritable = true;
    } catch {
      managedWritable = false;
    }

    return [
      "📷 照片权限状态",
      `库路径可读：${libraryReadable ? "是" : "否"}`,
      `原图目录可读：${originalsReadable ? "是" : "否"}`,
      `管理目录可读：${managedReadable ? "是" : "否"}`,
      `管理目录可写：${managedWritable ? "是" : "否"}`,
      `原图目录：${PHOTOS_ORIGINALS_PATH}`,
      `管理目录：${PHOTOS_MANAGED_DIR}`,
      `导出目录：${PHOTOS_EXPORT_BASE}`,
    ].join("\n");
  }

  if (text === "照片统计") {
    await mkdir(PHOTOS_MANAGED_DIR, { recursive: true });
    await access(PHOTOS_MANAGED_DIR, fsConstants.R_OK);
    const cmd = `find ${shellQuote(PHOTOS_MANAGED_DIR)} -type f | wc -l`;
    const { stdout } = await execFileAsync("/bin/zsh", ["-lc", cmd], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    const count = stdout.trim() || "0";
    return `📷 管理目录照片数：${count}\n目录：${PHOTOS_MANAGED_DIR}`;
  }

  const syncCount = parsePhotoSyncCount(text);
  if (syncCount != null) {
    await access(PHOTOS_ORIGINALS_PATH, fsConstants.R_OK);
    await mkdir(PHOTOS_MANAGED_DIR, { recursive: true });
    const newest = await getNewestPhotoFilesFromDir(PHOTOS_ORIGINALS_PATH, syncCount);
    if (newest.length === 0) {
      return "系统照片库里没有找到可同步的文件。";
    }

    let copied = 0;
    for (const src of newest) {
      try {
        const dest = path.join(PHOTOS_MANAGED_DIR, path.basename(src));
        await copyFile(src, dest);
        copied += 1;
      } catch {
        continue;
      }
    }

    return [
      `📥 同步完成：${copied}/${newest.length}`,
      `管理目录：${PHOTOS_MANAGED_DIR}`,
      "后续微信管理将基于这个目录。",
    ].join("\n");
  }

  const exportCount = parsePhotoExportCount(text);
  if (exportCount != null) {
    await mkdir(PHOTOS_MANAGED_DIR, { recursive: true });
    await access(PHOTOS_MANAGED_DIR, fsConstants.R_OK);
    await mkdir(PHOTOS_EXPORT_BASE, { recursive: true });

    const newest = await getNewestPhotoFilesFromDir(PHOTOS_MANAGED_DIR, exportCount);
    if (newest.length === 0) {
      return `管理目录中没有可导出的照片。\n先发“照片同步最新 10”再试。`;
    }

    const batchDir = path.join(PHOTOS_EXPORT_BASE, `batch-${formatTimestampForDir()}`);
    await mkdir(batchDir, { recursive: true });

    let copied = 0;
    for (const src of newest) {
      try {
        const dest = path.join(batchDir, path.basename(src));
        await copyFile(src, dest);
        copied += 1;
      } catch {
        continue;
      }
    }

    return [
      `📦 导出完成：${copied}/${newest.length}`,
      `目录：${batchDir}`,
      "提示：你可以在 Finder 打开该目录查看。",
    ].join("\n");
  }

  return null;
}

async function ensureLoggedIn(client) {
  const status = await callTool(client, "check_qrcode_status", {});
  if (status?.status === "confirmed") {
    log("WeChat login confirmed.");
    return true;
  }

  if (status?.status) {
    log("WeChat login status:", status.status);
    return false;
  }

  log("No valid login state found. Generating QR code...");
  const qr = await callTool(client, "login_qrcode", {});
  log("Scan QR from:", qr?.url || "~/.mcp-wechat-server/qrcode.png");
  return false;
}

async function processMessage(client, state, message) {
  const to = message.from_user_id;
  const text = (message.text || "").trim();
  const mediaItems = Array.isArray(message.media) ? message.media : [];
  const imageMedia = mediaItems.find((m) => m?.kind === "image");
  state.lastSender = to;

  if (!to || !text) return;

  if (text.includes(WAKE_WORD)) {
    state.awake = true;
    await saveState(state);
    await callTool(client, "send_text_message", {
      to,
      text: `已唤醒✅（唤醒词：${WAKE_WORD}）`,
    });
    log("Switched to awake mode.");
    return;
  }

  if (text.includes(SLEEP_WORD)) {
    state.awake = false;
    await saveState(state);
    await callTool(client, "send_text_message", {
      to,
      text: `已进入休眠模式😴（退出词：${SLEEP_WORD}）。\n休眠中仅监测唤醒词“${WAKE_WORD}”。`,
    });
    log("Switched to sleep mode.");
    return;
  }

  if (!state.awake) {
    return;
  }
  const pendingForUser = state.pendingImages?.[to];

  if (text === "[Image]" || imageMedia) {
    const encryptParam = imageMedia?.encrypt_query_param;
    const aeskey = imageMedia?.aeskey;
    const aesKey = imageMedia?.aes_key;

    if (!encryptParam || (!aeskey && !aesKey)) {
      await sendNaturalReply(
        client,
        to,
        "收到图片但缺少下载参数，请用户重发图片，或改用管理目录 ~/Pictures/claw_photos_managed。",
      );
      log("Image message missing download params.");
      return;
    }

    await mkdir(WECHAT_INBOX_DIR, { recursive: true });
    const savePath = buildInboundImagePath(message.message_id, "jpg");
    const downloaded = await callTool(client, "download_image", {
      encrypt_query_param: encryptParam,
      aeskey,
      aes_key: aesKey,
      save_to: savePath,
    });

    const finalPath = downloaded?.saved_path || savePath;
    const size = downloaded?.size;
    const mime = downloaded?.mime;

    state.pendingImages = state.pendingImages || {};
    state.pendingImages[to] = {
      path: finalPath,
      messageId: message.message_id,
      receivedAt: now(),
    };
    await saveState(state);

    await sendNaturalReply(
      client,
      to,
      [
        "已收到并缓存这张图片。",
        "请让用户直接提问想看什么内容；如果只想存档，可让用户回复“保存”，不处理可回复“取消”。",
        size ? `图片大小：${size} bytes` : "",
        mime ? `图片类型：${mime}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    log("Saved inbound image to inbox and asked for action.");
    return;
  }

  const routed = await routeIntentByAI({
    text,
    hasPendingImage: Boolean(pendingForUser?.path),
    hasLastSavedImage: Boolean(state.lastImages?.[to]),
  });

  if (routed.intent === "shutdown") {
    await sendNaturalReply(client, to, `用户触发了关闭指令（${SHUTDOWN_WORD}），请确认我将停止后台监听。`);
    log("Sent shutdown confirmation.");
    log("Received shutdown intent; exiting daemon.");
    await saveState(state);
    process.exit(0);
  }

  if (routed.intent === "analyze_pending_image") {
    const pending = state.pendingImages?.[to];
    const lastImagePath = pending?.path || state.lastImages?.[to];
    if (!lastImagePath) {
      await sendNaturalReply(client, to, "当前没有可分析的图片，请先发一张图片。语气自然简短。");
      return;
    }

    let typingTimer = null;
    try {
      await callTool(client, "send_typing", { to, status: "typing" });
      typingTimer = setInterval(() => {
        callTool(client, "send_typing", { to, status: "typing" }).catch(() => {});
      }, 18000);
      const analysis = await analyzeImageConversation(lastImagePath, text);
      await callTool(client, "send_text_message", { to, text: analysis });
      if (pending?.path) {
        state.pendingImages = state.pendingImages || {};
        delete state.pendingImages[to];
        await saveState(state);
      }
      log("Sent analysis for last image.");
    } catch (error) {
      await sendNaturalReply(
        client,
        to,
        `这次图片分析失败，错误是：${error?.message || "unknown error"}。请自然地建议用户重试。`,
      );
      log("Failed analyzing last image.");
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      await callTool(client, "send_typing", { to, status: "cancel" }).catch(() => {});
    }
    return;
  }

  if (routed.intent === "save_pending_image") {
    const pending = state.pendingImages?.[to];
    if (!pending?.path) {
      await sendNaturalReply(client, to, "当前没有待保存图片，请让用户先发图。语气自然。",);
      return;
    }
    try {
      await mkdir(PHOTOS_MANAGED_DIR, { recursive: true });
      const ext = path.extname(pending.path) || ".jpg";
      const safeRequested = routed.params.filename ? sanitizeFileBaseName(routed.params.filename) : null;
      const baseName = safeRequested || `wechat-saved-${pending.messageId ?? Date.now()}`;
      const savedPath = await makeUniquePath(PHOTOS_MANAGED_DIR, baseName, ext);
      await copyFile(pending.path, savedPath);
      await unlink(pending.path).catch(() => {});

      state.lastImages = state.lastImages || {};
      state.lastImages[to] = savedPath;
      state.pendingImages = state.pendingImages || {};
      delete state.pendingImages[to];
      await saveState(state);

      await sendNaturalReply(client, to, `图片已保存成功，路径是：${savedPath}`);
      log("Saved pending image to managed directory.");
    } catch (error) {
      await sendNaturalReply(client, to, `图片保存失败，错误是：${error?.message || "unknown error"}`);
    }
    return;
  }

  if (routed.intent === "cancel_pending_image") {
    const pending = state.pendingImages?.[to];
    if (!pending?.path) {
      await sendNaturalReply(client, to, "当前没有待处理的图片。请自然回答。",);
      return;
    }
    await unlink(pending.path).catch(() => {});
    state.pendingImages = state.pendingImages || {};
    delete state.pendingImages[to];
    await saveState(state);
    await sendNaturalReply(client, to, "本次图片操作已取消，临时文件已清理。",);
    log("Cancelled pending image operation.");
    return;
  }

  if (routed.intent === "rename_managed_image") {
    const newBaseSafe = routed.params.to_name ? sanitizeFileBaseName(routed.params.to_name) : null;
    if (!newBaseSafe) {
      await sendNaturalReply(client, to, "我没识别到有效的新文件名。你可以说：把A改名B。",);
      return;
    }
    let sourcePath = null;
    if (routed.params.from_name) {
      sourcePath = await findManagedImagePathByBase(routed.params.from_name);
    }
    if (!sourcePath && state.lastImages?.[to] && state.lastImages[to].startsWith(PHOTOS_MANAGED_DIR)) {
      sourcePath = state.lastImages[to];
    }
    if (!sourcePath) {
      await sendNaturalReply(client, to, "我没找到你要改名的那张图。你可以说完整一点：把旧文件名改名新文件名。",);
      return;
    }
    try {
      const ext = path.extname(sourcePath) || ".jpg";
      const targetPath = await makeUniquePath(PHOTOS_MANAGED_DIR, newBaseSafe, ext);
      await fsRename(sourcePath, targetPath);
      state.lastImages = state.lastImages || {};
      state.lastImages[to] = targetPath;
      await saveState(state);
      await sendNaturalReply(client, to, `改名完成，新的路径是：${targetPath}`);
    } catch (error) {
      await sendNaturalReply(client, to, `改名失败，错误是：${error?.message || "unknown error"}`);
    }
    return;
  }

  if (routed.intent === "photo_status" || routed.intent === "photo_stats" || routed.intent === "photo_sync_latest" || routed.intent === "photo_export_latest") {
    const map = {
      photo_status: "照片状态",
      photo_stats: "照片统计",
      photo_sync_latest: `照片同步最新 ${routed.params.count || 10}`,
      photo_export_latest: `照片导出最新 ${routed.params.count || 10}`,
    };
    const op = map[routed.intent];
    const photoReply = await handlePhotoCommand(op).catch((error) => `照片命令执行失败：${error?.message || "unknown error"}`);
    await sendNaturalReply(client, to, `请用自然口语转述这条结果并保留关键信息：\n${photoReply}`);
    log("Sent photo command reply.");
    return;
  }

  let typingTimer = null;
  try {
    await callTool(client, "send_typing", { to, status: "typing" });
    typingTimer = setInterval(() => {
      callTool(client, "send_typing", { to, status: "typing" }).catch(() => {});
    }, 18000);

    const reply = await generateReplyFromOpenClaw(text);
    await callTool(client, "send_text_message", { to, text: reply });
    log("Sent model reply.");
  } catch (error) {
    const fallback = `抱歉，这次处理失败了：${error?.message || "unknown error"}`;
    await callTool(client, "send_text_message", { to, text: fallback });
    log("Sent fallback error reply.");
  } finally {
    if (typingTimer) clearInterval(typingTimer);
    await callTool(client, "send_typing", { to, status: "cancel" }).catch(() => {});
  }
}

async function runOnce() {
  const state = await loadState();
  await saveState(state);

  const client = new Client({ name: "wechat-claw-daemon", version: "1.0.0" });
  const transport =
    MCP_MODE === "local"
      ? new StdioClientTransport({
          command: BUN_PATH,
          args: [MCP_LOCAL_ENTRY],
        })
      : new StdioClientTransport({
          command: BUNX_PATH,
          args: ["mcp-wechat-server"],
        });

  await client.connect(transport);
  log("Connected to mcp-wechat-server.");

  const ok = await ensureLoggedIn(client);
  if (!ok) {
    log("Waiting for login confirmation...");
  }

  while (true) {
    try {
      const payload = await callTool(client, "get_messages", { wait: true, timeout: 60000 });
      const messages = payload?.messages || [];
      if (!Array.isArray(messages) || messages.length === 0) continue;

      for (const message of messages) {
        if (message?.type !== "received") continue;
        log("Received message", `id=${message.message_id} text=${JSON.stringify(message.text || "")}`);
        await processMessage(client, state, message);
      }
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("Request timed out")) {
        continue;
      }
      log("Loop error:", message);
      throw error;
    }
  }
}

async function main() {
  while (true) {
    try {
      await runOnce();
    } catch (error) {
      log("Daemon crashed, retrying in 5s:", String(error?.message || error));
      await sleep(5000);
    }
  }
}

main().catch((error) => {
  log("Fatal error:", String(error?.message || error));
  process.exit(1);
});
