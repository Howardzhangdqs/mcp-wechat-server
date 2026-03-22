import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { AccountData, ServerState, QrLoginState } from "../api/types.js";

export const DATA_DIR = path.join(os.homedir(), ".mcp-wechat-server");

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function loadAccount(): AccountData | null {
  return readJson<AccountData>(path.join(DATA_DIR, "account.json"));
}

export function saveAccount(account: AccountData): void {
  writeJson(path.join(DATA_DIR, "account.json"), account);
  try { fs.chmodSync(path.join(DATA_DIR, "account.json"), 0o600); } catch { /* best-effort */ }
}

export function clearAccount(): void {
  try { fs.unlinkSync(path.join(DATA_DIR, "account.json")); } catch { /* ignore */ }
}

export function loadState(): ServerState {
  const defaultState: ServerState = {
    updatesBuf: "",
    contextTokens: {},
    lastMessageId: 0,
  };
  return readJson<ServerState>(path.join(DATA_DIR, "state.json")) ?? defaultState;
}

export function saveState(state: ServerState): void {
  writeJson(path.join(DATA_DIR, "state.json"), state);
}

export function resetState(): void {
  saveState({ updatesBuf: "", contextTokens: {}, lastMessageId: 0 });
}

export function loadQrState(): QrLoginState | null {
  return readJson<QrLoginState>(path.join(DATA_DIR, "qr_login.json"));
}

export function saveQrState(state: QrLoginState): void {
  writeJson(path.join(DATA_DIR, "qr_login.json"), state);
}

export function clearQrState(): void {
  try { fs.unlinkSync(path.join(DATA_DIR, "qr_login.json")); } catch { /* ignore */ }
}
