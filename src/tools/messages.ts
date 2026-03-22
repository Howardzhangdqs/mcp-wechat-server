import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { getUpdates } from "../api/client.js";
import { loadAccount, loadState, saveState } from "../store/account.js";
import type { WeixinMessage } from "../api/types.js";

const LONG_POLL_MS = 25_000;

export const getMessagesSchema = z.object({
  wait: z
    .boolean()
    .optional()
    .describe("If true, block until at least one new message arrives. May block for a very long time (7 days max). Requires the MCP client to have no tool timeout limit."),
  timeout: z
    .number()
    .min(1000)
    .max(60000)
    .optional()
    .describe("Long-poll timeout in ms (default: 10000). Ignored when wait=true."),
});

export async function getMessages(input: { wait?: boolean; timeout?: number }): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const account = loadAccount();
  if (!account?.botToken) {
    throw new McpError(ErrorCode.InvalidParams, "Not logged in. Call login_qrcode first.");
  }

  const pollMs = input.wait ? LONG_POLL_MS : (input.timeout ?? 10000);
  let state = loadState();
  const deadline = input.wait ? Date.now() + 7 * 24 * 3600_000 : 0;

  while (true) {
    if (deadline && Date.now() > deadline) {
      saveState(state);
      return {
        content: [
          { type: "text", text: JSON.stringify({ message_count: 0, messages: [] }, null, 2) },
        ],
      };
    }

    const resp = await getUpdates({
      baseUrl: account.baseUrl,
      token: account.botToken,
      updatesBuf: state.updatesBuf,
      timeoutMs: pollMs,
    });

    if (resp.errcode) {
      throw new McpError(
        ErrorCode.InternalError,
        `Server error: errcode=${resp.errcode} errmsg=${resp.errmsg ?? "unknown"}`,
      );
    }

    if (resp.get_updates_buf) {
      state.updatesBuf = resp.get_updates_buf;
    }

    const newMessages = resp.msgs?.filter(
      (m) => m.message_type === 1 && m.message_id && m.message_id > state.lastMessageId,
    ) ?? [];

    if (newMessages.length > 0) {
      const maxId = Math.max(...newMessages.map((m) => m.message_id ?? 0));
      state.lastMessageId = maxId;

      for (const msg of newMessages) {
        const key = `${account.botId}:${msg.from_user_id}`;
        if (msg.context_token) {
          state.contextTokens[key] = msg.context_token;
        }
      }

      saveState(state);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message_count: newMessages.length,
              messages: newMessages.map(formatMessage),
            }, null, 2),
          },
        ],
      };
    }

    if (!input.wait) {
      saveState(state);
      return {
        content: [
          { type: "text", text: JSON.stringify({ message_count: 0, messages: [] }, null, 2) },
        ],
      };
    }
  }
}

function formatMessage(msg: WeixinMessage) {
  const items = msg.item_list ?? [];
  const textParts: string[] = [];

  for (const item of items) {
    switch (item.type) {
      case 1:
        textParts.push(item.text_item?.text ?? "");
        break;
      case 2:
        textParts.push("[Image]");
        break;
      case 3:
        textParts.push(item.voice_item?.text ? `[Voice: ${item.voice_item.text}]` : "[Voice]");
        break;
      case 4:
        textParts.push(item.file_item?.file_name ? `[File: ${item.file_item.file_name}]` : "[File]");
        break;
      case 5:
        textParts.push("[Video]");
        break;
    }
  }

  let text = textParts.join("\n");

  if (msg.ref_msg) {
    const refItem = msg.ref_msg.message_item;
    const refText = refItem?.text_item?.text ?? msg.ref_msg.title ?? "";
    text = `[Reply to: ${refText}]\n${text}`;
  }

  return {
    message_id: msg.message_id,
    from_user_id: msg.from_user_id,
    to_user_id: msg.to_user_id,
    type: msg.message_type === 1 ? "received" : "sent",
    text,
    context_token: msg.context_token,
    create_time: msg.create_time_ms ? new Date(msg.create_time_ms).toISOString() : undefined,
  };
}
