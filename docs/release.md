# Release Guide

This project ships local macOS builds as a DMG. Build artifacts stay in `dist/` and are not committed.

## Build A DMG

```bash
PATH=/usr/local/bin:$PATH /usr/local/bin/npm run package:dmg
```

The command runs:

1. `npm run build`
2. `electron-builder --mac dir`
3. `hdiutil create`

The output files are:

```text
dist/Claude Pets-<version>-<arch>.dmg
dist/Claude Pets-<version>-<arch>.dmg.sha256
dist/release-upload.md
```

`dist/release-upload.md` is regenerated on every package build with the exact `gh release create` command for the current package version.

## Version A New Release

The DMG filename and release guide use `version` from `package.json`.

For normal releases, bump the version first:

```bash
npm version patch
```

Use `minor` or `major` when appropriate:

```bash
npm version minor
npm version major
```

To set an exact version:

```bash
npm version 0.2.0
```

Then build:

```bash
PATH=/usr/local/bin:$PATH /usr/local/bin/npm run package:dmg
```

## Upload To GitHub Releases

After a successful build, open `dist/release-upload.md` and run the generated command. It will look like this:

```bash
git status --short
git tag v0.1.0
git push origin HEAD
git push origin v0.1.0
gh release create v0.1.0 \
  "dist/Claude Pets-0.1.0-arm64.dmg" \
  "dist/Claude Pets-0.1.0-arm64.dmg.sha256" \
  --title "Claude Pets v0.1.0" \
  --notes "See CHANGELOG or the release notes for this version."
```

If `npm version` already created the tag, skip `git tag v<version>` and just push the existing tag.

## Packaging Notes

- `electronDist` points at `node_modules/electron/dist` so packaging reuses the locally installed Electron runtime instead of downloading it again.
- `hooks/` and `pets/` are packaged as `extraResources`, so first-launch setup copies from real directories under `Claude Pets.app/Contents/Resources`.
- The hook command uses `ELECTRON_RUN_AS_NODE=1`, so installed users do not need Node.js on their `PATH`.
- The local DMG is ad-hoc signed for bundle consistency but not notarized. Public releases should eventually add Developer ID signing and notarization.
