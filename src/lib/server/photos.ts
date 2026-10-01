// ANDON photo storage. Two backends, same names and API:
//   - BLOB_READ_WRITE_TOKEN set → Vercel Blob, PRIVATE objects under "andon-photos/" (Vercel deployment)
//   - otherwise                 → local folder UPLOAD_DIR (local PC / plant server)
// Photos are always served through /api/photos/<name> (never a public URL); names are generated here.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR } from "./db.ts";
import { AndonError } from "./errors.ts";

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

const BLOB_PREFIX = "andon-photos/";
const blobStorageEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;

export async function savePhoto(file: File): Promise<string> {
  const ext = EXT[file.type];
  if (!ext) throw new AndonError(400, "사진은 JPG/PNG/WEBP/HEIC 형식만 가능합니다.", "INVALID_PHOTO");
  if (file.size > MAX_BYTES) throw new AndonError(400, "사진은 10MB 이하만 가능합니다.", "PHOTO_TOO_LARGE");
  const name = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  if (blobStorageEnabled()) {
    const { put } = await import("@vercel/blob");
    await put(BLOB_PREFIX + name, bytes, { access: "private", contentType: file.type, addRandomSuffix: false });
    return name;
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), bytes);
  return name;
}

export async function deletePhoto(name: string) {
  if (!PHOTO_NAME.test(name)) return;
  if (blobStorageEnabled()) {
    const { del } = await import("@vercel/blob");
    await del(BLOB_PREFIX + name).catch((err) => console.error("[photos] blob delete failed", err));
    return;
  }
  await fs.rm(path.join(UPLOAD_DIR, name), { force: true });
}

/** Photo bytes, or null if unknown / missing. */
export async function readPhoto(name: string): Promise<Uint8Array | null> {
  if (!PHOTO_NAME.test(name)) return null;
  try {
    if (blobStorageEnabled()) {
      const { get } = await import("@vercel/blob");
      const r = await get(BLOB_PREFIX + name, { access: "private" });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      return new Uint8Array(await new Response(r.stream).arrayBuffer());
    }
    return new Uint8Array(await fs.readFile(path.join(UPLOAD_DIR, name)));
  } catch {
    return null;
  }
}
