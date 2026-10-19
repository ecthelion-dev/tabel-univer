// Tabel tizimi: server qismi (Netlify Function + Netlify Blobs)
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import seed from "./seed.mjs";

const COLS = ["employees", "departments", "exceptions", "tabels", "settings"];
const ROLE_LABEL = { admin: "Admin", kadr: "Kadrlar bo'limi", buxg: "Buxgalter", mudir: "Bo'lim mudiri" };
const MAX_FAILS = 8, LOCK_MS = 15 * 60e3;

const env = (k) => { try { const v = globalThis.Netlify?.env?.get?.(k); if (v) return v; } catch {} return process.env[k] || ""; };
const store = () => globalThis.__TEST_STORE || getStore({ name: "tabel", consistency: "strong" });
const SECRET = () => env("SECRET") || env("ADMIN_PASS");
const sign = (p) => crypto.createHmac("sha256", SECRET()).update(p).digest("base64url");
const hashPass = (p) => crypto.createHash("sha256").update(SECRET() + "|" + p).digest("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const ymNow = () => new Date().toISOString().slice(0, 7);

function mkToken(o) {
  const p = Buffer.from(JSON.stringify({ ...o, exp: Date.now() + 12 * 3600e3 })).toString("base64url");
  return p + "." + sign(p);
}
function auth(req) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [p, s] = t.split(".");
  if (!p || !s || !same(s, sign(p))) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
const byLabel = (a) => `${ROLE_LABEL[a.role] || a.role}${a.who ? ": " + a.who : ""}`;

/* ---------- saqlash: har to'plam bitta JSON, shartli yozish bilan ---------- */
async function readKey(st, key) {
  const r = await st.getWithMetadata(key, { type: "json" });
  return r ? { data: r.data, etag: r.etag } : { data: null, etag: null };
}
async function writeKey(st, key, data, etag) {
  const res = await st.setJSON(key, data, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
  return !res || res.modified !== false;
}
async function ensureSeed(st) {
  if (env("NO_SEED") || (await st.get("seeded"))) return;
  for (const c of COLS) if (seed[c]) await st.setJSON(c, seed[c], { onlyIfNew: true });
  await st.set("seeded", "1");
}
async function loadAll(st) {
  await ensureSeed(st);
  const maps = {}, etags = {};
  for (const c of COLS) { const r = await readKey(st, c); maps[c] = r.data || {}; etags[c] = r.etag; }
  return { maps, etags };
}
// O'qish -> o'zgartirish -> shartli yozish. Kimdir oraliqda yozsa, qaytadan.
async function txn(st, fn) {
  for (let i = 0; i < 6; i++) {
    const { maps, etags } = await loadAll(st);
    const r = fn(maps) || {};
    let ok = true;
    for (const c of r.touched || []) if (!(await writeKey(st, c, maps[c], etags[c]))) { ok = false; break; }
    if (ok) return { maps, ...r };
    await sleep(40 + Math.random() * 160 * (i + 1));
  }
  throw new HttpErr(409, "Ma'lumot shu payt boshqa joyda o'zgardi. Qayta urinib ko'ring.");
}
async function appendKey(st, key, items, cap) {
  for (let i = 0; i < 6; i++) {
    const r = await readKey(st, key);
    let arr = Array.isArray(r.data) ? r.data : [];
    arr = arr.concat(items);
    if (arr.length > cap) arr = arr.slice(-cap);
    if (await writeKey(st, key, arr, r.etag)) return;
    await sleep(30 + Math.random() * 100);
  }
}
const audit = (st, entries) => entries.length ? appendKey(st, "audit-" + ymNow(), entries, 5000) : null;

/* ---------- login cheklovi ---------- */
const rlKey = (ip) => "rl-" + crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 24);
async function rlLocked(st, ip) {
  const r = await st.get(rlKey(ip), { type: "json" });
  return r && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 60000) : 0;
}
async function rlFail(st, ip) {
  const k = rlKey(ip), now = Date.now();
  let r = (await st.get(k, { type: "json" })) || { n: 0, first: now };
  if (now - r.first > LOCK_MS) r = { n: 0, first: now };
  r.n++;
  if (r.n >= MAX_FAILS) r.until = now + LOCK_MS;
  await st.setJSON(k, r);
}

/* ---------- kim nimani ko'radi ---------- */
function view(m, a) {
  const out = {};
  const clean = (d) => { const { passHash, ...r } = d; if (a.role === "admin") r.hasPass = !!passHash; return r; };
  let depts = Object.entries(m.departments);
  let emps = Object.entries(m.employees);
  if (a.role === "mudir") {
    depts = depts.filter(([id]) => id === a.dept);
    emps = emps.filter(([, e]) => e.deptId === a.dept);
  }
  const empIds = new Set(emps.map(([id]) => id));
  out.departments = Object.fromEntries(depts.map(([id, d]) => [id, clean(d)]));
  out.employees = Object.fromEntries(emps);
  out.exceptions = Object.fromEntries(Object.entries(m.exceptions).filter(([, x]) => a.role !== "mudir" || empIds.has(x.empId)));
  out.tabels = Object.fromEntries(Object.entries(m.tabels).filter(([k]) => a.role !== "mudir" || k.startsWith(a.dept + "_")));
  out.settings = m.settings;
  return out;
}

const editable = (t) => !t || t.status === "draft" || t.status === "returned";

function allowed(a, op, c, id, data, m) {
  if (a.role === "admin") return true;
  if (a.role === "buxg") return false;
  if (a.role === "kadr") return ["employees", "exceptions", "tabels"].includes(c);
  if (a.role === "mudir") {
    if (c === "employees") {
      // Mudir faqat o'z bo'limi xodimlarini qo'shadi, tahrirlaydi, o'chiradi; boshqa bo'limga o'tkaza olmaydi
      const old = m.employees[id];
      if (old && old.deptId !== a.dept) return false;
      if (op === "delete") return !!old;
      const next = { ...(old || {}), ...(data || {}) };
      return next.deptId === a.dept;
    }
    if (c === "exceptions") {
      const old = m.exceptions[id];
      const x = op === "delete" ? old : { ...(old || {}), ...(data || {}) };
      if (!x || !x.empId || !x.from) return false;
      const emp = m.employees[x.empId];
      if (!emp || emp.deptId !== a.dept) return false;
      if (old && m.employees[old.empId]?.deptId !== a.dept) return false;
      const ym = String(x.from).slice(0, 7);
      // Avans tabeli tekshiruvda bo'lsa, 1–15 kunlarni o'zgartirib bo'lmaydi
      const touchesAvans = +String(x.from).slice(8, 10) <= 15 || (old && +String(old.from).slice(8, 10) <= 15);
      if (touchesAvans && m.tabels[`${a.dept}_${ym}_avans`]?.status === "submitted") return false;
      return editable(m.tabels[`${a.dept}_${ym}`]);
    }
    if (c === "tabels") {
      if (!id.startsWith(a.dept + "_") || op === "delete") return false;
      const cur = m.tabels[id];
      if (data.status === "submitted") return editable(cur);
      if (data.status === "draft") return !cur;
      return false;
    }
  }
  return false;
}

function summary(m, o) {
  const d = o.data || {}, old = m[o.col]?.[o.id] || {};
  if (o.col === "exceptions") { const x = { ...old, ...d }; return `${m.employees[x.empId]?.name || x.empId}: ${x.from || ""}${x.to && x.to !== x.from ? "…" + x.to : ""} ${x.val ?? ""}`; }
  if (o.col === "tabels") return `${o.id} → ${d.status || "o'chirildi"}${d.note ? " (" + d.note + ")" : ""}`;
  if (o.col === "employees") return d.name || old.name || o.id;
  if (o.col === "departments") return d.name || old.name || o.id;
  return o.col;
}

function applyOp(m, o, a) {
  const col = m[o.col];
  if (o.op === "delete") {
    if (o.col === "departments" && Object.values(m.employees).some((e) => e.deptId === o.id))
      throw new HttpErr(400, "Bo'limda xodimlar bor. Avval ularni boshqa bo'limga o'tkazing yoki o'chiring.");
    delete col[o.id];
    return;
  }
  let d = { ...(o.data || {}) };
  if (o.col === "departments" && typeof d.pass === "string") {
    if (d.pass) d.passHash = hashPass(d.pass);
    delete d.pass;
  }
  delete d.hasPass;
  if (o.col === "departments" && d.passHash && o.data?.passHash) delete d.passHash; // passHash faqat server o'zi qo'yadi
  if (o.col === "tabels") { d.by = byLabel(a); d.at = Date.now(); if (a.role === "mudir") delete d.snap; }
  if (o.col === "exceptions" && o.op === "set") d.by = byLabel(a);
  if (o.op === "set") {
    if (o.col === "departments" && col[o.id]?.passHash && !d.passHash) d.passHash = col[o.id].passHash;
    col[o.id] = d;
  } else if (o.op === "update") {
    if (!col[o.id]) throw new HttpErr(400, "Hujjat topilmadi");
    col[o.id] = { ...col[o.id], ...d };
  }
}

const genPassword = () => {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 10 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
};

export default async (req, context) => {
  if (!env("ADMIN_PASS")) return json({ error: "Server sozlanmagan: Netlify'da ADMIN_PASS muhit o'zgaruvchisini kiriting." }, 500);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, "");
  const st = store();
  const ip = req.headers.get("x-nf-client-connection-ip") || context?.ip || "local";
  try {
    if (path === "depts" && req.method === "GET") {
      await ensureSeed(st);
      const dd = (await readKey(st, "departments")).data || {};
      return json(Object.entries(dd).map(([id, x]) => ({ id, name: x.name, group: x.group || "", order: x.order || 0 })));
    }
    if (path === "login" && req.method === "POST") {
      const mins = await rlLocked(st, ip);
      if (mins) return json({ error: `Juda ko'p noto'g'ri urinish. ${mins} daqiqadan keyin qayta urinib ko'ring.` }, 429);
      const { role, dept, password, name } = await req.json();
      const who = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (who.length < 3) return json({ error: "Ismingizni kiriting (F.I.Sh.)" }, 400);
      const pw = String(password || "");
      await ensureSeed(st);
      let ok = false;
      if (role === "mudir") {
        const d = ((await readKey(st, "departments")).data || {})[dept];
        ok = !!(d && d.passHash && same(d.passHash, hashPass(pw)));
      } else {
        const key = { admin: "ADMIN_PASS", kadr: "KADR_PASS", buxg: "BUXG_PASS" }[role];
        ok = !!(key && env(key) && same(env(key), pw));
      }
      if (!ok) { await rlFail(st, ip); return json({ error: "Parol noto'g'ri" }, 401); }
      await st.delete(rlKey(ip));
      const a = { role, dept: role === "mudir" ? dept : "", who };
      await audit(st, [{ at: Date.now(), who: byLabel(a), op: "login", s: role === "mudir" ? dept : "" }]);
      return json({ token: mkToken(a), role, dept: a.dept, who });
    }

    const a = auth(req);
    if (!a) return json({ error: "Kirish kerak" }, 401);

    if (path === "data" && req.method === "GET") return json(view((await loadAll(st)).maps, a));

    if (path === "write" && req.method === "POST") {
      const { ops } = await req.json();
      if (!Array.isArray(ops) || !ops.length || ops.length > 200) return json({ error: "Noto'g'ri so'rov" }, 400);
      for (const o of ops)
        if (!COLS.includes(o.col) || !/^[\w.:@+-]{1,200}$/.test(String(o.id)) || !["set", "update", "delete"].includes(o.op))
          return json({ error: "Noto'g'ri amal" }, 400);
      let entries = [];
      const { maps } = await txn(st, (m) => {
        entries = [];
        const touched = new Set();
        for (const o of ops) {
          if (!allowed(a, o.op, o.col, o.id, o.data, m)) throw new HttpErr(403, "Bu amalga ruxsat yo'q");
          entries.push({ at: Date.now(), who: byLabel(a), op: o.op, col: o.col, id: o.id, s: summary(m, o) });
          applyOp(m, o, a);
          touched.add(o.col);
        }
        return { touched };
      });
      await audit(st, entries);
      return json(view(maps, a));
    }

    if (path === "genpass" && req.method === "POST") {
      if (a.role !== "admin") return json({ error: "Faqat admin" }, 403);
      const { all } = await req.json().catch(() => ({}));
      let list = [];
      await txn(st, (m) => {
        list = [];
        for (const [id, d] of Object.entries(m.departments)) {
          if (d.passHash && !all) continue;
          const pw = genPassword();
          m.departments[id] = { ...d, passHash: hashPass(pw) };
          list.push({ id, name: d.name, group: d.group || "", pass: pw });
        }
        return { touched: list.length ? ["departments"] : [] };
      });
      await audit(st, [{ at: Date.now(), who: byLabel(a), op: "genpass", s: `${list.length} ta bo'lim` }]);
      return json({ list });
    }

    if (path === "audit" && req.method === "GET") {
      if (a.role !== "admin" && a.role !== "kadr") return json({ error: "Ruxsat yo'q" }, 403);
      const ym = /^\d{4}-\d{2}$/.test(url.searchParams.get("ym") || "") ? url.searchParams.get("ym") : ymNow();
      const arr = (await readKey(st, "audit-" + ym)).data || [];
      return json(arr.slice(-1000).reverse());
    }

    if (path === "backup" && req.method === "GET") {
      if (a.role !== "admin") return json({ error: "Faqat admin" }, 403);
      const { maps } = await loadAll(st);
      await audit(st, [{ at: Date.now(), who: byLabel(a), op: "backup", s: "zaxira yuklab olindi" }]);
      return json({ app: "tabel-tizimi", version: 1, at: new Date().toISOString(), cols: maps });
    }

    if (path === "restore" && req.method === "POST") {
      if (a.role !== "admin") return json({ error: "Faqat admin" }, 403);
      const body = await req.json();
      if (!body || body.app !== "tabel-tizimi" || typeof body.cols !== "object") return json({ error: "Bu tabel tizimi zaxira fayli emas" }, 400);
      for (const c of COLS) if (body.cols[c] && (typeof body.cols[c] !== "object" || Array.isArray(body.cols[c]))) return json({ error: "Zaxira fayli buzilgan: " + c }, 400);
      for (const c of COLS) await st.setJSON(c, body.cols[c] || {});
      await st.set("seeded", "1");
      await audit(st, [{ at: Date.now(), who: byLabel(a), op: "restore", s: "zaxiradan tiklandi (" + (body.at || "") + ")" }]);
      return json(view((await loadAll(st)).maps, a));
    }

    return json({ error: "Topilmadi" }, 404);
  } catch (e) {
    if (e instanceof HttpErr) return json({ error: e.message }, e.status);
    return json({ error: "Server xatosi: " + (e.message || e) }, 500);
  }
};

export const config = { path: "/api/*" };
