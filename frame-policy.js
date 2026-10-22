// Framing is opt-in for exact operator-configured HTTPS origins. Authentication is unchanged.
export function framePolicy(value) {
  if (!value?.trim()) return { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" };
  const origins = value.split(",").map(item => {
    const url = new URL(item.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("FRAME_ANCESTORS must contain exact HTTPS origins");
    }
    return url.origin;
  });
  return { "Content-Security-Policy": `frame-ancestors 'self' ${[...new Set(origins)].join(" ")}` };
}
