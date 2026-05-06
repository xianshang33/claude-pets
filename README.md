# Claude Pets

<p align="right">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/assets/hero.gif" alt="Claude Pets desktop companion gallery" width="760">
</p>

<p align="center">
  A tiny macOS desktop pet for Claude Code.
  Inspired by Codex Pet, it brings a similar companion experience to Claude Code:
  agent status animations, compact bubbles, and permission actions from your desktop.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#add-a-pet">Add a Pet</a> ·
  <a href="docs/pet-format.md">Pet Format</a> ·
  <a href="docs/troubleshooting.md">Troubleshooting</a>
</p>

## Demo

<p align="center">
  <img src="docs/assets/demo-idle.gif" alt="Claude Pets idle demo" width="24%"><img src="docs/assets/demo-thinking.gif" alt="Claude Pets thinking demo" width="24%"><img src="docs/assets/demo-review.gif" alt="Claude Pets review demo" width="24%"><img src="docs/assets/demo-switch-pets.gif" alt="Claude Pets switch pet menu demo" width="24%">
</p>

## Highlights

- Reacts to Claude Code hook events.
- Shows compact status and permission bubbles.
- Supports `Allow` / `Deny` for permission requests.
- Loads Codex-compatible pet packages from `~/.claude/pets`.
- Use Codex pets directly: copy a pet package into Claude Pets' pets directory.
- Stays local: the bridge listens on `127.0.0.1`.

## Quick Start

Requires macOS, Claude Code, and Node.js 22 or newer.

```bash
npm install
npm run setup
npm start
```

`npm run setup` creates `~/.claude/pets` and adds the Claude Code hook command to `~/.claude/settings.json`.
It preserves unrelated Claude settings.

## Add a Pet

Copy a Codex-compatible pet package into Claude's pet folder:

```bash
mkdir -p ~/.claude/pets
cp -R /path/to/<pet-id> ~/.claude/pets/
```

Each pet folder needs:

```text
~/.claude/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

PNG spritesheets are also supported. See [Pet Format](docs/pet-format.md).

Looking for pets? Try the community pet market at [codex-pets.net](https://codex-pets.net/), then copy the downloaded pet folder into `~/.claude/pets`.

## Status

Claude Pets is early and macOS-only.

- Source install only for now.
- Does not bundle, copy, or sync Codex assets.
- Unofficial project, not affiliated with Anthropic, OpenAI, Claude Code, or Codex.

## Docs

- [Pet format](docs/pet-format.md)
- [Claude hooks setup](docs/setup-claude-hooks.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

License pending.
