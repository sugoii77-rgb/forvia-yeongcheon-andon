import type { MetadataRoute } from "next";

// Web app manifest: lets employees put Digital ANDON on the phone's home screen like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Digital ANDON · 영천",
    short_name: "ANDON",
    description: "FORVIA 영천공장 Digital ANDON — 호출, 조치, 현황판",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b2d5b",
    theme_color: "#0b2d5b",
    lang: "ko",
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
