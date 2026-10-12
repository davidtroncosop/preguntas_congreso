// Utilidades compartidas entre la vista pública y el panel de moderación.

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.round(m / 60)} h`;
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

// WebSocket con reconexión automática y ping para mantener viva la conexión.
export function liveSocket(path, { onState, onStatus }) {
  let ws, pingTimer, retry = 0, stopped = false;
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}${path}`);
    ws.onopen = () => {
      retry = 0;
      onStatus?.(true);
      pingTimer = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      const msg = JSON.parse(e.data);
      if (msg.type === "state") onState(msg.state);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      onStatus?.(false);
      if (stopped) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * 2 ** retry);
    };
  };
  connect();
  return { close: () => { stopped = true; ws?.close(); } };
}
