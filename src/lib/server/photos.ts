import fs from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR } from "./db";
import { AndonError } from "./andonService";

const MAX_BYTES = 10 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
export const CONTENT_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(EXT).map(([type, ext]) => [ext, type]),
);

/** Only names produced by savePhoto() are valid: prevents path traversal. */
export const PHOTO_NAME = /^[A-Za-z0-9_-]+\.(jpg|png|webp|heic|heif)$/;

export async function savePhoto(file: File): Promise<string> {
  const ext = EXT[file.type];
  if (!ext) throw new AndonError(400, "사진은 JPG/PNG/WEBP/HEIC 형식만 가능합니다.", "INVALID_PHOTO");
  if (file.size > MAX_BYTES) throw new AndonError(400, "사진은 10MB 이하만 가능합니다.", "PHOTO_TOO_LARGE");
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), Buffer.from(await file.arrayBuffer()));
  return name;
}

export async function deletePhoto(name: string) {
  await fs.rm(path.join(UPLOAD_DIR, name), { force: true });
}

export async function readPhoto(name: string): Promise<Buffer | null> {
  if (!PHOTO_NAME.test(name)) return null;
  try {
    return await fs.readFile(path.join(UPLOAD_DIR, name));
  } catch {
    return null;
  }
}
