# WeChat Claw Daemon (Example)

This example runs a 24x7 WeChat listener that:

- long-polls `get_messages`
- handles wake/sleep words
- downloads inbound images via `download_image`
- routes image questions + text to `openclaw agent`
- optionally saves images to `~/Pictures/claw_photos_managed`

## Quick start

```bash
cd /ABSOLUTE/PATH/TO/mcp-wechat-server
bun install
bun examples/wechat-claw-daemon/wechat-claw-daemon.mjs
```

## launchd (macOS)

1. Copy `com.example.wechat-claw-daemon.plist` to `~/Library/LaunchAgents/`
2. Replace placeholder absolute paths
3. Load service:

```bash
launchctl unload -w "$HOME/Library/LaunchAgents/com.example.wechat-claw-daemon.plist" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/com.example.wechat-claw-daemon.plist"
launchctl kickstart -k gui/$(id -u)/com.example.wechat-claw-daemon
```

## Environment variables

- `WECHAT_MCP_MODE`: `local` (default) or `npm`
- `WECHAT_MCP_ENTRY`: path to local `src/index.ts`
- `WECHAT_OPENCLAW_PATH`: path to `openclaw` binary
- `WECHAT_WAKE_WORD`: default `你好claw`
- `WECHAT_SLEEP_WORD`: default `再见claw`
