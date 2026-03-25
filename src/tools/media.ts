import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { downloadEncryptedMedia } from "../api/client.js";

export const downloadImageSchema = z.object({
  encrypt_query_param: z.string().min(1).describe("Encrypted query param from image_item.media.encrypt_query_param"),
  aeskey: z.string().optional().describe("Hex AES key from image_item.aeskey (32 hex chars)"),
  aes_key: z.string().optional().describe("Base64 AES key from image_item.media.aes_key"),
  save_to: z.string().optional().describe("Optional absolute path to save decrypted image"),
});

function parseKey(input: { aeskey?: string; aes_key?: string }): Buffer {
  if (input.aeskey?.trim()) {
    const hex = input.aeskey.trim();
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
      throw new McpError(ErrorCode.InvalidParams, "aeskey must be 32 hex chars");
    }
    return Buffer.from(hex, "hex");
  }

  if (!input.aes_key?.trim()) {
    throw new McpError(ErrorCode.InvalidParams, "Either aeskey or aes_key is required");
  }

  const raw = Buffer.from(input.aes_key.trim(), "base64");
  if (raw.length === 16) {
    return raw;
  }

  const rawText = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{32}$/.test(rawText)) {
    return Buffer.from(rawText, "hex");
  }

  throw new McpError(ErrorCode.InvalidParams, "Unable to parse aes_key as a 16-byte key");
}

function detectImageMeta(buf: Buffer): { mime: string; extension: string } {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", extension: "png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") {
      return { mime: "image/gif", extension: "gif" };
    }
  }
  return { mime: "application/octet-stream", extension: "bin" };
}

export async function downloadImage(input: {
  encrypt_query_param: string;
  aeskey?: string;
  aes_key?: string;
  save_to?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const key = parseKey(input);
  const encrypted = await downloadEncryptedMedia({ encryptQueryParam: input.encrypt_query_param });

  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  const meta = detectImageMeta(decrypted);
  let savedPath: string | undefined;
  if (input.save_to?.trim()) {
    const finalPath = input.save_to.trim();
    await writeFile(finalPath, decrypted);
    savedPath = path.resolve(finalPath);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            size: decrypted.length,
            mime: meta.mime,
            extension: meta.extension,
            saved_path: savedPath,
            base64: decrypted.toString("base64"),
          },
          null,
          2,
        ),
      },
    ],
  };
}
