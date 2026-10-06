// The app icon (home screen / browser tab): an andon signal tower — red, amber, green — on navy, with
// "ANDON" below. Rendered to PNG by next/og (ImageResponse); `pad` = safe-area margin (maskable: 14 %).
export function appIcon(size: number, pad = 0.06) {
  const s = size * (1 - 2 * pad);
  const u = s / 100;
  const lamp = (h: number, color: string, glow = false) => (
    <div style={{ width: 36 * u, height: h * u, borderRadius: 5 * u, background: color, marginTop: 2 * u, boxShadow: glow ? `0 0 ${10 * u}px rgba(255,80,80,0.9)` : "none" }} />
  );
  return (
    <div style={{ width: size, height: size, background: "#0b2d5b", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: s, height: s, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: 24 * u, height: 6 * u, borderRadius: 3 * u, background: "#c9d3e3", marginTop: 6 * u }} />
        {lamp(18, "#e5202e", true)}
        {lamp(16, "#f5b800")}
        {lamp(16, "#1f9d55")}
        <div style={{ width: 6 * u, height: 7 * u, background: "#c9d3e3" }} />
        <div style={{ width: 28 * u, height: 5 * u, borderRadius: 2 * u, background: "#c9d3e3" }} />
        <div style={{ color: "#ffffff", fontSize: 15 * u, fontWeight: 800, marginTop: 4 * u, letterSpacing: 0.5 * u }}>ANDON</div>
      </div>
    </div>
  );
}
