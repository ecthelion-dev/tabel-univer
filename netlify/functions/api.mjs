// Tabel tizimi: server qismi (Netlify Function + Netlify Blobs)
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import seed from "./seed.mjs";

const COLS = ["employees", "departments", "exceptions", "tabels", "settings"];
const env = (k) => { try { const v = globalThis.Netlify?.env?.get?.(k); if (v) return v; } catch {} return process.env[k] || ""; };
const store = () => globalThis.__TEST_STORE || getStore({ name: "tabel", consistency: "strong" });
const SECRET = () => env("SECRET") || env("ADMIN_PASS");
const sign = (p) => crypto.createHmac("sha256", SECRET()).update(p).digest("base64url");
const hashPass = (p) => crypto.createHash("sha256").update(SECRET() + "|" + p).digest("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (msg, status = 400) => json({ error: msg }, status);

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

async function loadCol(st, c) { return (await st.get(c, { type: "json" })) || {}; }
async function ensureSeed(st) {
  if (env("NO_SEED") || (await st.get("seeded"))) return;
  for (const c of COLS) if (seed[c]) await st.setJSON(c, seed[c]);
  await st.set("seeded", "1");
}
async function loadAll(st) {
  await ensureSeed(st);
  const m = {};
  for (const c of COLS) m[c] = await loadCol(st, c);
  return m;
}

// Har rol faqat o'z ko'rishi kerak bo'lgan ma'lumotni oladi
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
    if (c === "exceptions") {
      const old = m.exceptions[id];
      const x = op === "delete" ? old : { ...(old || {}), ...(data || {}) };
      if (!x || !x.empId || !x.from) return false;
      const emp = m.employees[x.empId];
      if (!emp || emp.deptId !== a.dept) return false;
      if (old && m.employees[old.empId]?.deptId !== a.dept) return false;
      return editable(m.tabels[`${a.dept}_${String(x.from).slice(0, 7)}`]);
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

function applyOp(m, o) {
  const col = m[o.col];
  if (o.op === "delete") { delete col[o.id]; return; }
  let d = { ...(o.data || {}) };
  if (o.col === "departments" && typeof d.pass === "string") {
    if (d.pass) d.passHash = hashPass(d.pass);
    delete d.pass;
  }
  delete d.hasPass;
  if (o.op === "set") {
    if (o.col === "departments" && col[o.id]?.passHash && !d.passHash) d.passHash = col[o.id].passHash;
    col[o.id] = d;
  } else if (o.op === "update") {
    if (!col[o.id]) throw new Error("Hujjat topilmadi");
    col[o.id] = { ...col[o.id], ...d };
  }
}

export default async (req) => {
  if (!env("ADMIN_PASS")) return fail("Server sozlanmagan: Netlify'da ADMIN_PASS muhit o'zgaruvchisini kiriting.", 500);
  const path = new URL(req.url).pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, "");
  const st = store();
  try {
    if (path === "depts" && req.method === "GET") {
      await ensureSeed(st);
      const dd = await loadCol(st, "departments");
      return json(Object.entries(dd).map(([id, x]) => ({ id, name: x.name, group: x.group || "", order: x.order || 0 })));
    }
    if (path === "login" && req.method === "POST") {
      const { role, dept, password } = await req.json();
      const pw = String(password || "");
      await ensureSeed(st);
      if (role === "mudir") {
        const d = (await loadCol(st, "departments"))[dept];
        if (!d || !d.passHash || !same(d.passHash, hashPass(pw))) return fail("Parol noto'g'ri", 401);
        return json({ token: mkToken({ role, dept }), role, dept });
      }
      const key = { admin: "ADMIN_PASS", kadr: "KADR_PASS", buxg: "BUXG_PASS" }[role];
      if (!key || !env(key) || !same(env(key), pw)) return fail("Parol noto'g'ri", 401);
      return json({ token: mkToken({ role }), role });
    }
    const a = auth(req);
    if (!a) return fail("Kirish kerak", 401);
    if (path === "data" && req.method === "GET") return json(view(await loadAll(st), a));
    if (path === "write" && req.method === "POST") {
      const { ops } = await req.json();
      if (!Array.isArray(ops) || ops.length > 200) return fail("Noto'g'ri so'rov");
      const m = await loadAll(st);
      const touched = new Set();
      for (const o of ops) {
        if (!COLS.includes(o.col) || !/^[\w.:@+-]{1,200}$/.test(String(o.id)) || !["set", "update", "delete"].includes(o.op)) return fail("Noto'g'ri amal");
        if (!allowed(a, o.op, o.col, o.id, o.data, m)) return fail("Bu amalga ruxsat yo'q", 403);
        applyOp(m, o); touched.add(o.col);
      }
      for (const c of touched) await st.setJSON(c, m[c]);
      return json(view(m, a));
    }
    if (path === "genpass" && req.method === "POST") {
      if (a.role !== "admin") return fail("Faqat admin", 403);
      const { all } = await req.json().catch(() => ({}));
      const m = await loadCol(st, "departments");
      const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
      const list = [];
      for (const [id, d] of Object.entries(m)) {
        if (d.passHash && !all) continue;
        const pw = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
        m[id] = { ...d, passHash: hashPass(pw) };
        list.push({ id, name: d.name, group: d.group || "", pass: pw });
      }
      await st.setJSON("departments", m);
      return json({ list });
    }
    return fail("Topilmadi", 404);
  } catch (e) {
    return fail("Server xatosi: " + (e.message || e), 500);
  }
};

export const config = { path: "/api/*" };
