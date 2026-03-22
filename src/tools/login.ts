import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import QRCode from "qrcode";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { fetchQRCode, pollQRStatus } from "../api/client.js";
import {
  loadAccount, saveAccount, clearAccount,
  loadQrState, saveQrState, clearQrState,
  loadState, resetState, DATA_DIR,
} from "../store/account.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

const QR_TTL_MS = 5 * 60_000;

function isQrFresh(createdAt: number): boolean {
  return Date.now() - createdAt < QR_TTL_MS;
}

async function saveQrPng(url: string): Promise<string> {
  const qrPath = path.join(DATA_DIR, "qrcode.png");
  const txtPath = path.join(DATA_DIR, "qrcode.txt");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await Promise.all([
    QRCode.toFile(qrPath, url, { width: 400, margin: 2 }),
    QRCode.toString(url, { type: "terminal", small: true }).then((str) => {
      fs.writeFileSync(txtPath, str, "utf-8");
    }),
  ]);
  return qrPath;
}

function qrHelpText(qrUrl: string, qrPath: string, txtPath: string): string {
  return [
    "WeChat login QR code generated. You MUST do ALL of the following:",
    "",
    `1. Run \`cat ${txtPath}\` yourself to display the QR code in terminal for the user to scan.`,
    `2. Tell the user they can also open the image at: ${qrPath}`,
    `3. Tell the user they can also send this URL to WeChat and open it: ${qrUrl}`,
    "",
    "Important: Show ALL THREE options to the user. You must run the cat command yourself, do not ask the user to run it.",
    "Note: If the user's phone WiFi cannot load the page, ask them to switch to mobile data network.",
    "After the user scans the QR code, call check_qrcode_status to verify login.",
  ].join("\n");
}

export const loginQrcodeSchema = z.object({});

export async function loginQrcode(): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const account = loadAccount();
  if (account?.botToken) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "already_logged_in",
            message: "Already logged in. Use logout first if you want to re-login.",
            botId: account.botId,
            userId: account.userId,
          }, null, 2),
        },
      ],
    };
  }

  const existing = loadQrState();
  const qrUrl = existing?.qrcodeUrl;
  const qrPath = path.join(DATA_DIR, "qrcode.png");
  const txtPath = path.join(DATA_DIR, "qrcode.txt");

  if (existing && isQrFresh(existing.createdAt) && qrUrl) {
    if (!fs.existsSync(qrPath) || !fs.existsSync(txtPath)) {
      await saveQrPng(qrUrl);
    }
    return {
      content: [
        {
          type: "text",
          text: qrHelpText(qrUrl, qrPath, txtPath),
        },
      ],
    };
  }

  const qrResponse = await fetchQRCode(DEFAULT_BASE_URL);
  saveQrState({
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrResponse.qrcode_img_content,
    createdAt: Date.now(),
  });

  await saveQrPng(qrResponse.qrcode_img_content);

  return {
    content: [
      {
        type: "text",
        text: qrHelpText(qrResponse.qrcode_img_content, qrPath, txtPath),
      },
    ],
  };
}

export const checkQrcodeStatusSchema = z.object({});

export async function checkQrcodeStatus(): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const account = loadAccount();
  if (account?.botToken) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "confirmed",
            message: "Already logged in.",
            botId: account.botId,
            userId: account.userId,
          }, null, 2),
        },
      ],
    };
  }

  const qrState = loadQrState();
  if (!qrState) {
    throw new McpError(ErrorCode.InvalidParams, "No pending QR code. Call login_qrcode first.");
  }

  if (!isQrFresh(qrState.createdAt)) {
    clearQrState();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "expired",
            message: "QR code expired. Call login_qrcode to generate a new one.",
          }, null, 2),
        },
      ],
    };
  }

  const statusResponse = await pollQRStatus(DEFAULT_BASE_URL, qrState.qrcode);

  if (statusResponse.status === "confirmed") {
    if (!statusResponse.bot_token || !statusResponse.ilink_bot_id || !statusResponse.ilink_user_id) {
      throw new McpError(ErrorCode.InternalError, "Login confirmed but server returned incomplete data.");
    }

    saveAccount({
      botToken: statusResponse.bot_token,
      botId: statusResponse.ilink_bot_id,
      userId: statusResponse.ilink_user_id,
      baseUrl: statusResponse.baseurl ?? DEFAULT_BASE_URL,
      savedAt: Date.now(),
    });

    clearQrState();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "confirmed",
            message: "Login successful! Bot is now connected to WeChat.",
            botId: statusResponse.ilink_bot_id,
            userId: statusResponse.ilink_user_id,
          }, null, 2),
        },
      ],
    };
  }

  if (statusResponse.status === "expired") {
    clearQrState();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "expired",
            message: "QR code expired. Call login_qrcode to generate a new one.",
          }, null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: statusResponse.status,
          message:
            statusResponse.status === "wait"
              ? "Waiting for QR code scan. Call check_qrcode_status again after scanning."
              : "QR code scanned, waiting for confirmation in WeChat. Call check_qrcode_status again.",
        }, null, 2),
      },
    ],
  };
}

export const logoutSchema = z.object({});

export async function logout(): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  clearQrState();
  resetState();
  clearAccount();

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "logged_out", message: "Logged out successfully." }, null, 2),
      },
    ],
  };
}
