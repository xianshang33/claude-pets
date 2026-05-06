# Pet Format

Claude Pets reads custom pets from:

```text
~/.claude/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

PNG spritesheets are also supported.

## Manifest

```json
{
  "id": "mianmian",
  "displayName": "Mianmian",
  "description": "A Codex-compatible pet.",
  "spritesheetPath": "spritesheet.webp"
}
```

`spritesheetPath` must resolve inside the pet folder. Symlinks that point outside the pet folder are rejected.

## Atlas

The spritesheet must be `1536x1872`, arranged as 8 columns by 9 rows.

Each frame is `192x208`.

| Row | State |
| --- | --- |
| 0 | `idle` |
| 1 | `running-right` |
| 2 | `running-left` |
| 3 | `waving` |
| 4 | `jumping` |
| 5 | `failed` |
| 6 | `waiting` |
| 7 | `running` |
| 8 | `review` |

This matches Codex custom pet packages, so you can manually copy a Codex custom pet into `~/.claude/pets`.
