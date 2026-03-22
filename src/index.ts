#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadAccount } from "./store/account.js";
import { loginQrcode, checkQrcodeStatus, loginQrcodeSchema, checkQrcodeStatusSchema, logoutSchema, logout } from "./tools/login.js";
import { getMessages, getMessagesSchema } from "./tools/messages.js";
import { sendTextMessage, sendTextMessageSchema } from "./tools/send.js";
import { sendTypingIndicator, sendTypingSchema } from "./tools/typing.js";

const server = new McpServer(
  {
    name: "mcp-wechat-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.tool(
  "login_qrcode",
  "Get a WeChat login QR code. Scan it with WeChat to connect the bot. Returns the QR code URL. Call check_qrcode_status afterwards to verify.",
  loginQrcodeSchema.shape,
  async () => {
    return await loginQrcode();
  },
);

server.tool(
  "check_qrcode_status",
  "Check if the QR code (from login_qrcode) has been scanned and confirmed. Call this repeatedly until status is 'confirmed'.",
  checkQrcodeStatusSchema.shape,
  async () => {
    return await checkQrcodeStatus();
  },
);

server.tool(
  "logout",
  "Log out the current WeChat bot session and clear all saved credentials.",
  logoutSchema.shape,
  async () => {
    return await logout();
  },
);

server.tool(
  "get_messages",
  `Poll for new WeChat messages. Always call with wait=true to block until a message arrives.

IMPORTANT BEHAVIOR — you MUST follow this workflow:
1. Call get_messages with wait=true and a very large timeout (e.g. 60000). This is a long-polling call that blocks until a message arrives. Set your tool call timeout to at least 120 seconds to avoid premature cancellation.
2. When you receive a message and start processing it (thinking, generating a reply, etc.), immediately call send_typing with status="typing" and to=<from_user_id> to show the user that you are typing.
3. While you are still processing the request, keep calling send_typing with status="typing" periodically (every 15-20 seconds) to keep the typing indicator alive.
4. Once you have finished processing and sent your reply via send_text_message, call send_typing with status="cancel" and to=<from_user_id> to stop the typing indicator.

This ensures the WeChat user sees a "typing..." indicator while you are working on their request.`,
  getMessagesSchema.shape,
  async (input) => {
    return await getMessages(input);
  },
);

server.tool(
  "send_text_message",
  "Send a text message to a WeChat user. The 'to' field is the user ID from a received message.",
  sendTextMessageSchema.shape,
  async (input) => {
    return await sendTextMessage(input);
  },
);

server.tool(
  "send_typing",
  "Send or cancel a typing indicator to a WeChat user. The 'to' field is the user ID from a received message. Status 'typing' shows the indicator, 'cancel' stops it.",
  sendTypingSchema.shape,
  async (input) => {
    return await sendTypingIndicator(input);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const account = loadAccount();
  if (account?.botToken) {
    console.error(`[mcp-wechat] Connected. Logged in as bot ${account.botId}, user ${account.userId}`);
  } else {
    console.error("[mcp-wechat] Connected. Not logged in. Call login_qrcode to start.");
  }
}

main().catch((err) => {
  console.error("[mcp-wechat] Fatal error:", err);
  process.exit(1);
});
