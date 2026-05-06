import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PetAtlas, PetPackage, PetPackageWarning } from "./types";

const expectedAtlas: PetAtlas = {
  width: 1536,
  height: 1872,
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208
};

type PetManifest = {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
};

type LoadPetPackageResult =
  | {
      pet: PetPackage;
      warning: null;
    }
  | {
      pet: null;
      warning: PetPackageWarning;
    };

export async function scanPetPackages(petsDirectory: string): Promise<{
  pets: PetPackage[];
  warnings: PetPackageWarning[];
}> {
  const entries = await readdir(petsDirectory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const results = await Promise.all(
    directories.map((directoryName) => loadPetPackage(path.join(petsDirectory, directoryName), directoryName))
  );

  return {
    pets: results.flatMap((result) => (result.pet ? [result.pet] : [])),
    warnings: results.flatMap((result) => (result.warning ? [result.warning] : []))
  };
}

export async function loadPetPackage(petDirectory: string, fallbackPetId: string): Promise<LoadPetPackageResult> {
  const manifestPath = path.join(petDirectory, "pet.json");
  let manifest: PetManifest;

  try {
    manifest = parsePetManifest(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    return warning(fallbackPetId, `Invalid pet.json: ${getErrorMessage(cause)}`);
  }

  const spritesheetResolution = resolveSpritesheetPath(petDirectory, manifest.spritesheetPath);
  if (!spritesheetResolution.ok) {
    return warning(manifest.id, spritesheetResolution.message);
  }

  try {
    await stat(spritesheetResolution.path);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return warning(manifest.id, `Missing spritesheet: ${manifest.spritesheetPath}`);
    }
    return warning(manifest.id, `Unable to read spritesheet: ${getErrorMessage(cause)}`);
  }

  let checkedSpritesheetPath: string;
  try {
    const [realPetDirectory, realSpritesheetPath] = await Promise.all([
      realpath(petDirectory),
      realpath(spritesheetResolution.path)
    ]);
    const relativeRealPath = path.relative(realPetDirectory, realSpritesheetPath);

    if (relativeRealPath === "" || relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
      return warning(manifest.id, "Spritesheet path must resolve inside its pet folder");
    }

    checkedSpritesheetPath = realSpritesheetPath;
  } catch (cause) {
    return warning(manifest.id, `Unable to read spritesheet: ${getErrorMessage(cause)}`);
  }

  let dimensions: { width: number; height: number };
  try {
    dimensions = readImageDimensions(await readFile(checkedSpritesheetPath), checkedSpritesheetPath);
  } catch (cause) {
    return warning(manifest.id, `Invalid spritesheet: ${getErrorMessage(cause)}`);
  }

  if (dimensions.width !== expectedAtlas.width || dimensions.height !== expectedAtlas.height) {
    return warning(
      manifest.id,
      `Invalid spritesheet dimensions: expected 1536x1872, got ${dimensions.width}x${dimensions.height}`
    );
  }

  return {
    pet: {
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description,
      spritesheetPath: checkedSpritesheetPath,
      atlas: expectedAtlas
    },
    warning: null
  };
}

export function parsePetManifest(json: string): PetManifest {
  const manifest = JSON.parse(json) as Record<string, unknown>;

  return {
    id: readRequiredString(manifest, "id"),
    displayName: readRequiredString(manifest, "displayName"),
    description: readRequiredString(manifest, "description"),
    spritesheetPath: readRequiredString(manifest, "spritesheetPath")
  };
}

function readRequiredString(manifest: Record<string, unknown>, field: keyof PetManifest): string {
  const value = manifest[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing ${field}`);
  }
  return value.trim();
}

export function resolveSpritesheetPath(
  petDirectory: string,
  spritesheetPath: string
):
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      message: string;
    } {
  const extension = path.extname(spritesheetPath).toLowerCase();
  if (extension !== ".webp" && extension !== ".png") {
    return {
      ok: false,
      message: "Spritesheet must be a WebP or PNG file"
    };
  }

  const resolvedPetDirectory = path.resolve(petDirectory);
  const resolvedSpritesheetPath = path.resolve(resolvedPetDirectory, spritesheetPath);
  const relativePath = path.relative(resolvedPetDirectory, resolvedSpritesheetPath);

  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return {
      ok: false,
      message: "Spritesheet path must resolve inside its pet folder"
    };
  }

  return {
    ok: true,
    path: resolvedSpritesheetPath
  };
}

export function readImageDimensions(buffer: Buffer, filePath: string): { width: number; height: number } {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") {
    return readPngDimensions(buffer);
  }
  if (extension === ".webp") {
    return readWebpDimensions(buffer);
  }
  throw new Error("unsupported image format");
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 24 ||
    buffer.readUInt32BE(0) !== 0x89504e47 ||
    buffer.readUInt32BE(4) !== 0x0d0a1a0a ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("invalid PNG header");
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("invalid WebP header");
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkDataOffset + chunkSize > buffer.length) {
      throw new Error("truncated WebP chunk");
    }

    if (chunkType === "VP8X") {
      if (chunkSize < 10) {
        throw new Error("invalid VP8X chunk");
      }
      return {
        width: buffer.readUIntLE(chunkDataOffset + 4, 3) + 1,
        height: buffer.readUIntLE(chunkDataOffset + 7, 3) + 1
      };
    }

    if (chunkType === "VP8 ") {
      if (chunkSize < 10) {
        throw new Error("invalid VP8 chunk");
      }
      return {
        width: buffer.readUInt16LE(chunkDataOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(chunkDataOffset + 8) & 0x3fff
      };
    }

    if (chunkType === "VP8L") {
      if (chunkSize < 5 || buffer.readUInt8(chunkDataOffset) !== 0x2f) {
        throw new Error("invalid VP8L chunk");
      }
      const bits = buffer.readUInt32LE(chunkDataOffset + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1
      };
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  throw new Error("missing WebP dimension chunk");
}

function warning(petId: string, message: string): LoadPetPackageResult {
  return {
    pet: null,
    warning: {
      petId,
      message
    }
  };
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
