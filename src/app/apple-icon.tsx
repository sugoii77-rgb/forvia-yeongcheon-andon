import { ImageResponse } from "next/og";
import { appIcon } from "@/lib/appIcon";

// iPhone / iPad home-screen icon ("홈 화면에 추가").
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(appIcon(180, 0.08), size);
}
