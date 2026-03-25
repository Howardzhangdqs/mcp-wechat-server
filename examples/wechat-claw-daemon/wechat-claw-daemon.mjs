#!/usr/bin/env bun

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const BUN_PATH = process.env.WECHAT_BUN_PATH || "bun";
const BUNX_PATH = process.env.WECHAT_BUNX_PATH || "bunx";
const OPENCLAW_PATH = process.env.WECHAT_OPENCLAW_PATH || "openclaw";
const MCP_MODE = process.env.WECHAT_MCP_MODE || "local"; // local | npm
const MCP_LOCAL_ENTRY = process.env.WECHAT_MCP_ENTRY || path.join(process.cwd(), "src", "index.ts");

const WAKE_WORD = process.env.WECHAT_WAKE_WORD || "你好claw";
const SLEEP_WORD = process.env.WECHAT_SLEEP_WORD || "再见claw";

const STATE_DIR = path.join(os.homedir(), ".mcp-wechat-server");
const STATE_FILE = path.join(STATE_DIR, "wake-daemon-state.json");
const INBOX_DIR = path.join(STATE_DIR, "inbox_images");
const MANAGED_DIR = path.join(os.homedir(), "Pictures", "claw_photos_managed");

function now() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    return {
      awake: typeof s.awake === "boolean" ? s.awake : true,
      pendingImages: s.pendingImages && typeof s.pendingImages === "object" ? s.pendingImages : {},
    };
  } catch {
    return { awake: true, pendingImages: {} };
  }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    STATE_FILE,
    JSON.stringify({ awake: state.awake, pendingImages: state.pendingImages, updatedAt: now() }, null, 2),
    "utf8",
  );
}

function parseToolResult(result) {
  const text = result?.content?.find?.((it) => it?.type === "text")?.text;
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

async function askModel(text) {
  const { stdout } = await execFileAsync(OPENCLAW_PATH, ["agent", "--agent", "main", "--message", text], {
    timeout: 240000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim() || "我收到了，但这次没有生成内容。";
}

async function askModelByImage(imagePath, userText) {
  const prompt = [
    "你是用户的微信AI助手，语气自然，像普通微信聊天。",
    `图片路径：${imagePath}`,
    `用户消息：${userText || "请描述这张图"}`,
    "直接回答，不要模板标题，不要项目符号。",
  ].join("\n");
  return askModel(prompt);
}

function imageInboxPath(messageId, ext = "jpg") {
  const e = /^[a-zA-Z0-9]{1,6}$/.test(ext) ? ext : "jpg";
  return path.join(INBOX_DIR, `wechat-inbound-${messageId ?? Date.now()}.${e}`);
}

function isSaveIntent(text) {
  return /保存|存起来/.test(text);
}

function isCancelIntent(text) {
  return /取消|算了|不用了/.test(text);
}

async function processMessage(client, state, message) {
  const to = message.from_user_id;
  const text = (message.text || "").trim();
  if (!to || !text) return;

  if (text.includes(WAKE_WORD)) {
    state.awake = true;
    await saveState(state);
    await callTool(client, "send_text_message", { to, text: "我在，继续说。" });
    return;
  }

  if (text.includes(SLEEP_WORD)) {
    state.awake = false;
    await saveState(state);
    await callTool(client, "send_text_message", { to, text: "好，我先休眠；你发“你好claw”我再回来。" });
    return;
  }

  if (!state.awake) return;

  const pending = state.pendingImages?.[to];
  if (pending?.path && !isSaveIntent(text) && !isCancelIntent(text)) {
    const reply = await askModelByImage(pending.path, text);
    await callTool(client, "send_text_message", { to, text: reply });
    delete state.pendingImages[to];
    await saveState(state);
    return;
  }

  if (pending?.path && isSaveIntent(text)) {
    await mkdir(MANAGED_DIR, { recursive: true });
    const ext = path.extname(pending.path) || ".jpg";
    const savePath = path.join(MANAGED_DIR, `wechat-saved-${pending.messageId ?? Date.now()}${ext}`);
    await copyFile(pending.path, savePath);
    await unlink(pending.path).catch(() => {});
    delete state.pendingImages[to];
    await saveState(state);
    await callTool(client, "send_text_message", { to, text: `已保存：${savePath}` });
    return;
  }

  if (pending?.path && isCancelIntent(text)) {
    await unlink(pending.path).catch(() => {});
    delete state.pendingImages[to];
    await saveState(state);
    await callTool(client, "send_text_message", { to, text: "好的，这张图我不处理了。" });
    return;
  }

  const mediaItems = Array.isArray(message.media) ? message.media : [];
  const image = mediaItems.find((m) => m?.kind === "image");
  if (text === "[Image]" || image) {
    const encrypt = image?.encrypt_query_param;
    const aeskey = image?.aeskey;
    const aes_key = image?.aes_key;

    if (!encrypt || (!aeskey && !aes_key)) {
      await callTool(client, "send_text_message", { to, text: "这张图缺少下载参数，请重发一次。" });
      return;
    }

    await mkdir(INBOX_DIR, { recursive: true });
    const saveTo = imageInboxPath(message.message_id, "jpg");
    const d = await callTool(client, "download_image", {
      encrypt_query_param: encrypt,
      aeskey,
      aes_key,
      save_to: saveTo,
    });

    const imagePath = d?.saved_path || saveTo;
    state.pendingImages[to] = { path: imagePath, messageId: message.message_id, receivedAt: now() };
    await saveState(state);
    await callTool(client, "send_text_message", {
      to,
      text: "收到图啦。你直接说想让我看什么；要存档就回“保存”，不处理就回“取消”。",
    });
    return;
  }

  const reply = await askModel(text);
  await callTool(client, "send_text_message", { to, text: reply });
}

async function run() {
  const state = await loadState();
  await saveState(state);

  const client = new Client({ name: "wechat-claw-daemon", version: "1.0.0" });
  const transport =
    MCP_MODE === "local"
      ? new StdioClientTransport({ command: BUN_PATH, args: [MCP_LOCAL_ENTRY] })
      : new StdioClientTransport({ command: BUNX_PATH, args: ["mcp-wechat-server"] });

  await client.connect(transport);
  log("connected to MCP server");

  while (true) {
    try {
      const payload = await callTool(client, "get_messages", { wait: true, timeout: 60000 });
      const messages = payload?.messages || [];
      for (const m of messages) {
        if (m?.type !== "received") continue;
        await processMessage(client, state, m);
      }
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("Request timed out")) continue;
      log(`loop error: ${msg}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
