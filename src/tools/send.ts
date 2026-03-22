import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { sendMessage, generateId } from "../api/client.js";
import { loadAccount, loadState, saveState } from "../store/account.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { SendMessageReq } from "../api/types.js";

export const sendTextMessageSchema = z.object({
  to: z.string().min(1).describe("The WeChat user ID to send the message to."),
  text: z.string().min(1).describe("The text message to send."),
});

export async function sendTextMessage(input: { to: string; text: string }): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const account = loadAccount();
  if (!account?.botToken) {
    throw new McpError(ErrorCode.InvalidParams, "Not logged in. Call login_qrcode first.");
  }

  const state = loadState();
  const contextToken = state.contextTokens[`${account.botId}:${input.to}`];

  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: input.to,
      client_id: generateId("mcp-wechat"),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: input.text } }],
      context_token: contextToken,
    },
  };

  await sendMessage({
    baseUrl: account.baseUrl,
    token: account.botToken,
    body: req,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "sent",
          message: "Message sent successfully.",
          to: input.to,
          text: input.text,
          client_id: req.msg?.client_id,
        }, null, 2),
      },
    ],
  };
}
