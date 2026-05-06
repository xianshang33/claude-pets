# Troubleshooting

## No Pets Found

Claude Pets looked in `~/.claude/pets` but did not find a valid package.

Copy a Codex-compatible custom pet folder into `~/.claude/pets`, then choose reload in the app.

For local testing, `mianmian` is fine if it already exists locally. Claude Pets does not bundle or automatically sync Codex pet resources.

## Invalid Spritesheet

The spritesheet must be `1536x1872` and use `.webp` or `.png`.

If the app shows a warning about dimensions, check that you copied the whole pet folder and not a single cropped frame.

## Bridge Offline

The bridge runs inside the Electron app and listens on `127.0.0.1`.

Start the app with:

```bash
npm run dev
```

Then test the bridge with:

```bash
npm run simulate:bridge -- PreToolUse Bash
```

## Claude Hooks Do Nothing

Check that your Claude Code hook command points to the real path of `hooks/claude-pet-hook.js`.

The hook exits successfully even when Claude Pets is not running. That is intentional: it avoids blocking Claude Code.

## Permission Bubble Does Not Appear

Make sure your Claude Code settings include the `PermissionRequest` hook.

If Claude Pets is closed, the hook prints no decision and Claude Code should continue with its native permission flow.

## Large White Panel Or Debug Controls Appear

Normal mode should show only the naked pet overlay plus a compact bubble. Seeing a large white panel or debug controls without opting in is a regression.

Use debug mode only for diagnostics: add `?debug=1` to the renderer URL, or start the app with `CLAUDE_PET_DEBUG_UI=1`.

## Port Changed

Claude Pets tries `38987` first. If the port is occupied, it uses an available port and displays it in the app.

For hooks, set `CLAUDE_PET_BRIDGE_URL` or `CLAUDE_PET_BRIDGE_PORT` if you need a non-default port.

## E2E Visual Artifacts

When running the E2E tests, screenshots and other visual artifacts are written under the ignored `artifacts/` directory.
