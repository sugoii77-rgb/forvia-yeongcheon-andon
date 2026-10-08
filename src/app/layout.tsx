import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digital ANDON · Yeongcheon",
  description: "FORVIA Yeongcheon Plant Digital ANDON prototype",
  // iPhone "홈 화면에 추가": opens full-screen like an app, named "ANDON"
  appleWebApp: { capable: true, title: "ANDON", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b2d5b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
