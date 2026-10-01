"use client";
// Shrinks a camera photo on the device before upload: phone photos are 3–12 MB, which can
// time out on plant Wi-Fi. Output is a JPEG of at most MAX_EDGE px (typically 200–500 KB).
// Converting to JPEG also handles HEIC (iPhone) and other formats the browser can decode.

const MAX_EDGE = 1600;
const QUALITY = 0.8;

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall through to <img>, which some browsers decode more formats with
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Returns a resized JPEG File, or throws if the browser cannot decode the image. */
export async function preparePhoto(file: File): Promise<File> {
  const img = await decode(file);
  try {
    if (!img.width || !img.height) throw new Error("empty image");
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas not available");
    ctx.drawImage(img.source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob) throw new Error("JPEG encoding failed");
    return new File([blob], "andon-photo.jpg", { type: "image/jpeg" });
  } finally {
    img.close();
  }
}
