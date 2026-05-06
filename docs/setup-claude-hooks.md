# Claude Hooks Setup

Claude Pets listens on `http://127.0.0.1:38987` by default. For source checkouts, prefer the automatic setup command:

```bash
nvm use 22
npm install
npm run setup
npm start
```

`npm run setup` creates `~/.claude/pets` and merges the hook below into `~/.claude/settings.json` without removing unrelated settings or hook commands.

Use the manual JSON below only when you want to audit or install the hook yourself.

Replace `/absolute/path/to/claude-pet` with this repository's absolute path.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/claude-pet/hooks/claude-pet-hook.js"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/claude-pet/hooks/claude-pet-hook.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/claude-pet/hooks/claude-pet-hook.js"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/claude-pet/hooks/claude-pet-hook.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/claude-pet/hooks/claude-pet-hook.js"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/claude-pet/hooks/claude-pet-hook.js"
          }
        ]
      }
    ]
  }
}
```

Optional environment variables:

- `CLAUDE_PET_BRIDGE_URL`: full loopback bridge URL, for example `http://127.0.0.1:38987`. Non-loopback URLs are ignored.
- `CLAUDE_PET_BRIDGE_PORT`: bridge port when using the default localhost URL.
- `CLAUDE_PET_HOOK_TIMEOUT_MS`: forwarding timeout for non-permission events.
- `CLAUDE_PET_PERMISSION_TIMEOUT_MS`: maximum time to wait for an allow/deny decision. If the bridge is unavailable or no decision arrives, the hook prints no decision so Claude Code can use its native permission flow.
