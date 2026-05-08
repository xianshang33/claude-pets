import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const productName = packageJson.productName ?? "Claude Pets";
const version = packageJson.version;
const arch = process.arch === "arm64" ? "arm64" : "x64";
const appOutDir = path.join(root, "dist", arch === "arm64" ? "mac-arm64" : "mac");
const appPath = path.join(appOutDir, `${productName}.app`);
const dmgRoot = path.join(root, "dist", "dmg-root");
const dmgPath = path.join(root, "dist", `${productName}-${version}-${arch}.dmg`);
const checksumPath = `${dmgPath}.sha256`;
const releaseGuidePath = path.join(root, "dist", "release-upload.md");

async function run(command: string, args: string[]): Promise<void> {
  const child = execFileAsync(command, args, {
    cwd: root,
    env: process.env
  });
  child.child.stdout?.pipe(process.stdout);
  child.child.stderr?.pipe(process.stderr);
  await child;
}

async function main(): Promise<void> {
  await run("electron-builder", ["--mac", "dir"]);
  await rm(dmgRoot, { force: true, recursive: true });
  await rm(dmgPath, { force: true });
  await rm(checksumPath, { force: true });
  await rm(releaseGuidePath, { force: true });
  await mkdir(dmgRoot, { recursive: true });
  await cp(appPath, path.join(dmgRoot, `${productName}.app`), { recursive: true, verbatimSymlinks: true });
  await symlink("/Applications", path.join(dmgRoot, "Applications"));
  await run("hdiutil", ["create", "-volname", productName, "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgPath]);
  const checksum = await sha256File(dmgPath);
  await writeFile(checksumPath, `${checksum}  ${path.basename(dmgPath)}\n`);
  await writeFile(releaseGuidePath, createReleaseGuide(checksum));
  await rm(dmgRoot, { force: true, recursive: true });
  console.log(`Created ${dmgPath}`);
  console.log(`Created ${checksumPath}`);
  console.log(`Created ${releaseGuidePath}`);
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function createReleaseGuide(checksum: string): string {
  const dmgFileName = path.basename(dmgPath);
  const checksumFileName = path.basename(checksumPath);
  return `# Release Upload Guide

Generated for ${productName} v${version} (${arch}).

## Files

- ${dmgFileName}
- ${checksumFileName}

## SHA-256

\`\`\`text
${checksum}  ${dmgFileName}
\`\`\`

## GitHub Release

\`\`\`bash
git status --short
git tag v${version}
git push origin HEAD
git push origin v${version}
gh release create v${version} \\
  "dist/${dmgFileName}" \\
  "dist/${checksumFileName}" \\
  --title "${productName} v${version}" \\
  --notes "See CHANGELOG or the release notes for this version."
\`\`\`
`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
