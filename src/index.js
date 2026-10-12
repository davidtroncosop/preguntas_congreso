import { DurableObject } from "cloudflare:workers";

const MAX_QUESTION = 300;
const MAX_AUTHOR = 60;
const QUESTION_COOLDOWN_MS = 15_000;
const AI_TIMEOUT_MS = 25_000;
const MINIMAX_MODEL = "MiniMax-M2";
const MODERATION_PROMPT = `Eres el moderador de las preguntas que el público envía a los ponentes de un congreso.
Marca como NO apropiada solo una pregunta que contenga: insultos o ataques personales, discurso de odio o
discriminación, contenido sexual, amenazas o violencia, acoso, spam o publicidad, datos personales de terceros
(teléfonos, direcciones…) o texto sin sentido.
Las preguntas críticas, incómodas, polémicas o en desacuerdo con el ponente SÍ son apropiadas.
Responde únicamente con JSON: {"apropiada": true} o {"apropiada": false, "motivo": "<motivo breve en español>"}`;
const STATUSES = ["pending", "approved", "answered", "hidden"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const fail = (message, status = 400) => json({ error: message }, status);

// El PIN se comprueba aquí, en el Worker, porque siempre ve la versión actual de los secretos.
// Un Durable Object que lleva tiempo vivo podría seguir con el PIN anterior tras cambiarlo.
async function isAdmin(env, pin) {
  const expected = env.ADMIN_PIN;
  if (!expected || typeof pin !== "string") return false;
  const enc = new TextEncoder();
  const a = enc.encode(pin);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      const wantsAdmin =
        url.pathname.startsWith("/api/admin/") || (url.pathname === "/ws" && url.searchParams.get("role") === "admin");
      const pin = url.pathname === "/ws" ? url.searchParams.get("pin") : request.headers.get("x-admin-pin");
      if (wantsAdmin && !(await isAdmin(env, pin))) return fail("PIN incorrecto", 401);

      // El DO solo es accesible a través de este Worker: le indicamos si la petición es de admin.
      const headers = new Headers(request.headers);
      headers.delete("x-admin-pin");
      headers.set("x-is-admin", wantsAdmin ? "1" : "0");
      url.searchParams.delete("pin");

      // Un único "evento" por despliegue: todo el estado vive en un Durable Object.
      const stub = env.EVENT.get(env.EVENT.idFromName("main"));
      return stub.fetch(new Request(url, new Request(request, { headers })));
    }
    return env.ASSETS.fetch(request);
  },
};

export class EventRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.lastQuestionAt = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS talks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        speaker TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        talk_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        votes INTEGER NOT NULL DEFAULT 0,
        -- '' sin IA · 'checking' en revisión · 'ok' · 'error' · o el motivo del bloqueo
        ai_flag TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS votes (
        question_id INTEGER NOT NULL,
        voter TEXT NOT NULL,
        PRIMARY KEY (question_id, voter)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---------- helpers de estado ----------

  getSetting(key, fallback = null) {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = ?", key).toArray()[0];
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    if (value === null) this.sql.exec("DELETE FROM settings WHERE key = ?", key);
    else this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, String(value));
  }

  activeTalk() {
    const id = this.getSetting("active_talk");
    if (!id) return null;
    return this.sql.exec("SELECT id, title, speaker FROM talks WHERE id = ?", Number(id)).toArray()[0] ?? null;
  }

  publicState() {
    const talk = this.activeTalk();
    const questions = talk
      ? this.sql
          .exec(
            `SELECT id, text, author, status, votes, created_at FROM questions
             WHERE talk_id = ? AND status IN ('approved', 'answered')
             ORDER BY status = 'answered', votes DESC, created_at ASC`,
            talk.id,
          )
          .toArray()
      : [];
    return { eventName: this.getSetting("event_name", "Congreso"), talk, questions };
  }

  adminState() {
    const talks = this.sql
      .exec(
        `SELECT t.id, t.title, t.speaker, t.position,
           SUM(q.status = 'pending')  AS pending,
           SUM(q.status = 'approved') AS approved,
           SUM(q.status = 'answered') AS answered,
           SUM(q.status = 'hidden')   AS hidden
         FROM talks t LEFT JOIN questions q ON q.talk_id = t.id
         GROUP BY t.id ORDER BY t.position ASC, t.id ASC`,
      )
      .toArray();
    const questions = this.sql
      .exec(
        `SELECT id, talk_id, text, author, status, votes, ai_flag, created_at FROM questions
         ORDER BY votes DESC, created_at ASC`,
      )
      .toArray();
    const active = this.activeTalk();
    return {
      eventName: this.getSetting("event_name", "Congreso"),
      activeTalkId: active ? active.id : null,
      talks,
      questions,
    };
  }

  broadcast() {
    const pub = JSON.stringify({ type: "state", state: this.publicState() });
    for (const ws of this.ctx.getWebSockets("public")) {
      try { ws.send(pub); } catch {}
    }
    const admins = this.ctx.getWebSockets("admin");
    if (admins.length) {
      const adm = JSON.stringify({ type: "state", state: this.adminState() });
      for (const ws of admins) {
        try { ws.send(adm); } catch {}
      }
    }
  }

  // ---------- HTTP / WebSocket ----------

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return fail("Se esperaba WebSocket", 426);
      const role = url.searchParams.get("role") === "admin" ? "admin" : "public";
      if (role === "admin" && request.headers.get("x-is-admin") !== "1") return fail("PIN incorrecto", 401);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, [role]);
      const state = role === "admin" ? this.adminState() : this.publicState();
      server.send(JSON.stringify({ type: "state", state }));
      return new Response(null, { status: 101, webSocket: client });
    }

    let body = {};
    if (request.method === "POST" || request.method === "PATCH") {
      const raw = await request.text();
      if (raw.trim()) {
        try { body = JSON.parse(raw); } catch { return fail("JSON inválido"); }
      }
    }

    // --- Público ---
    if (path === "/api/state" && request.method === "GET") return json(this.publicState());

    if (path === "/api/questions" && request.method === "POST") return await this.createQuestion(body);

    if (path === "/api/vote" && request.method === "POST") return this.toggleVote(body);

    // --- Admin ---
    if (path.startsWith("/api/admin/")) {
      if (request.headers.get("x-is-admin") !== "1") return fail("PIN incorrecto", 401);
      const res = this.handleAdmin(request.method, path.slice("/api/admin".length), body);
      if (res.status < 300 && request.method !== "GET") this.broadcast();
      return res;
    }

    return fail("No encontrado", 404);
  }

  // Revisa el texto con MiniMax. Devuelve "ok", o el motivo si es inapropiado.
  // Si la IA falla devuelve null y la pregunta queda pendiente para revisión manual.
  async moderate(text) {
    try {
      const res = await fetch("https://api.minimax.io/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.MINIMAX_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 1500,
          messages: [
            { role: "system", content: MODERATION_PROMPT },
            { role: "user", content: text },
          ],
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      const data = await res.json();
      if (!res.ok || data.base_resp?.status_code) throw new Error(JSON.stringify(data.base_resp ?? data).slice(0, 200));
      if (data.input_sensitive) return "contenido sensible";
      const content = String(data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
      const verdict = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
      if (verdict.apropiada !== false) return "ok";
      return String(verdict.motivo || "inapropiada").slice(0, 80);
    } catch (err) {
      console.error("Moderación IA no disponible:", err);
      return null;
    }
  }

  async moderateQuestion(id, text) {
    const flag = await this.moderate(text);
    if (flag === null) {
      this.sql.exec("UPDATE questions SET ai_flag = 'error' WHERE id = ?", id);
    } else if (flag === "ok") {
      this.sql.exec("UPDATE questions SET ai_flag = 'ok' WHERE id = ?", id);
    } else {
      // Solo se oculta si el moderador no la ha tocado mientras tanto.
      this.sql.exec("UPDATE questions SET ai_flag = ? WHERE id = ?", flag, id);
      this.sql.exec("UPDATE questions SET status = 'hidden' WHERE id = ? AND status = 'pending'", id);
    }
    this.broadcast();
  }

  async createQuestion(body) {
    const talk = this.activeTalk();
    if (!talk) return fail("No hay ninguna ponencia abierta a preguntas en este momento.", 409);

    const text = String(body.text ?? "").trim();
    const author = String(body.author ?? "").trim().slice(0, MAX_AUTHOR);
    const voter = String(body.voter ?? "").slice(0, 64);
    if (text.length < 5) return fail("La pregunta es demasiado corta.");
    if (text.length > MAX_QUESTION) return fail(`Máximo ${MAX_QUESTION} caracteres.`);

    if (voter) {
      const last = this.lastQuestionAt.get(voter) ?? 0;
      if (Date.now() - last < QUESTION_COOLDOWN_MS) return fail("Espera unos segundos antes de enviar otra pregunta.", 429);
      this.lastQuestionAt.set(voter, Date.now());
    }

    const useAI = Boolean(this.env.MINIMAX_API_KEY) && this.env.AI_MODERATION !== "off";
    const { id } = this.sql
      .exec(
        "INSERT INTO questions (talk_id, text, author, ai_flag, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
        talk.id, text, author, useAI ? "checking" : "", Date.now(),
      )
      .one();
    this.broadcast();
    // La revisión IA corre en segundo plano para no hacer esperar al asistente.
    if (useAI) this.ctx.waitUntil(this.moderateQuestion(id, author ? `${author}: ${text}` : text));
    return json({ ok: true });
  }

  toggleVote(body) {
    const id = Number(body.questionId);
    const voter = String(body.voter ?? "").slice(0, 64);
    if (!id || voter.length < 8) return fail("Voto inválido.");

    const talk = this.activeTalk();
    const q = this.sql.exec("SELECT talk_id, status FROM questions WHERE id = ?", id).toArray()[0];
    if (!q || !talk || q.talk_id !== talk.id || q.status !== "approved") {
      return fail("Esta pregunta ya no admite votos.", 409);
    }

    const existing = this.sql.exec("SELECT 1 FROM votes WHERE question_id = ? AND voter = ?", id, voter).toArray().length > 0;
    if (existing) {
      this.sql.exec("DELETE FROM votes WHERE question_id = ? AND voter = ?", id, voter);
      this.sql.exec("UPDATE questions SET votes = votes - 1 WHERE id = ?", id);
    } else {
      this.sql.exec("INSERT INTO votes (question_id, voter) VALUES (?, ?)", id, voter);
      this.sql.exec("UPDATE questions SET votes = votes + 1 WHERE id = ?", id);
    }
    this.broadcast();
    return json({ ok: true, voted: !existing });
  }

  handleAdmin(method, path, body) {
    if (path === "/state" && method === "GET") return json(this.adminState());

    if (path === "/settings" && method === "POST") {
      const name = String(body.eventName ?? "").trim().slice(0, 80);
      if (name) this.setSetting("event_name", name);
      return json({ ok: true });
    }

    if (path === "/talks" && method === "POST") {
      const title = String(body.title ?? "").trim().slice(0, 160);
      const speaker = String(body.speaker ?? "").trim().slice(0, 120);
      if (!title) return fail("El título es obligatorio.");
      const max = this.sql.exec("SELECT COALESCE(MAX(position), 0) AS m FROM talks").one().m;
      this.sql.exec(
        "INSERT INTO talks (title, speaker, position, created_at) VALUES (?, ?, ?, ?)",
        title, speaker, max + 1, Date.now(),
      );
      return json({ ok: true });
    }

    if (path === "/close" && method === "POST") {
      this.setSetting("active_talk", null);
      return json({ ok: true });
    }

    let m = path.match(/^\/talks\/(\d+)(?:\/(activate|move))?$/);
    if (m) {
      const id = Number(m[1]);
      const exists = this.sql.exec("SELECT 1 FROM talks WHERE id = ?", id).toArray().length > 0;
      if (!exists) return fail("Ponencia no encontrada.", 404);

      if (m[2] === "activate" && method === "POST") {
        this.setSetting("active_talk", id);
        return json({ ok: true });
      }
      if (m[2] === "move" && method === "POST") {
        const dir = body.direction === "up" ? -1 : 1;
        const list = this.sql.exec("SELECT id FROM talks ORDER BY position ASC, id ASC").toArray().map((r) => r.id);
        const i = list.indexOf(id);
        const j = i + dir;
        if (j >= 0 && j < list.length) {
          [list[i], list[j]] = [list[j], list[i]];
          list.forEach((tid, idx) => this.sql.exec("UPDATE talks SET position = ? WHERE id = ?", idx + 1, tid));
        }
        return json({ ok: true });
      }
      if (!m[2] && method === "PATCH") {
        const title = String(body.title ?? "").trim().slice(0, 160);
        const speaker = String(body.speaker ?? "").trim().slice(0, 120);
        if (!title) return fail("El título es obligatorio.");
        this.sql.exec("UPDATE talks SET title = ?, speaker = ? WHERE id = ?", title, speaker, id);
        return json({ ok: true });
      }
      if (!m[2] && method === "DELETE") {
        this.sql.exec("DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE talk_id = ?)", id);
        this.sql.exec("DELETE FROM questions WHERE talk_id = ?", id);
        this.sql.exec("DELETE FROM talks WHERE id = ?", id);
        if (this.getSetting("active_talk") === String(id)) this.setSetting("active_talk", null);
        return json({ ok: true });
      }
    }

    m = path.match(/^\/questions\/(\d+)$/);
    if (m && method === "POST") {
      const status = String(body.status ?? "");
      if (!STATUSES.includes(status)) return fail("Estado inválido.");
      this.sql.exec("UPDATE questions SET status = ? WHERE id = ?", status, Number(m[1]));
      return json({ ok: true });
    }

    return fail("No encontrado", 404);
  }

  webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
  }
}
