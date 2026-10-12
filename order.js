// Vercel serverless funksiya: saytdagi formadan kelgan so'rovni Odoo CRM'ga lid qilib qo'shadi
// va (xohlasangiz) Telegram kanalga ham yuboradi. Ikkalasi ham ixtiyoriy: qaysi biri sozlangan bo'lsa, o'sha ishlaydi.
//
// Maxfiy qiymatlar kodda emas, Vercel "Environment Variables" bo'limida saqlanadi:
//   ODOO_URL           — masalan https://kompaniyam.odoo.com (oxirida / bo'lmasin)
//   ODOO_DB            — baza nomi (Odoo Online'da odatda subdomen nomi, masalan kompaniyam)
//   ODOO_API_KEY       — Odoo'da yaratilgan API kalit
//   ODOO_LOGIN         — Odoo'ga kirish emailingiz (faqat eski Odoo 17/18 uchun kerak)
//   TELEGRAM_BOT_TOKEN — (ixtiyoriy) BotFather bergan token
//   TELEGRAM_CHAT_ID   — (ixtiyoriy) @kanal_nomi yoki -100... raqami

// Narxlar serverda tekshiriladi, brauzerdan kelgan narxga ishonilmaydi.
const PRODUCTS = {
  c:  { name: "Vitamin C",    price: 89000 },
  d3: { name: "Vitamin D3",   price: 119000 },
  mv: { name: "Multivitamin", price: 149000 },
  o3: { name: "Omega-3",      price: 169000 }
};

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Odoo'dagi eski JSON-RPC (Odoo 17/18) uchun yordamchi
async function rpc(base, service, method, args) {
  const r = await fetch(base + "/jsonrpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service: service, method: method, args: args }, id: Date.now() })
  });
  const j = await r.json();
  if (j.error) throw new Error("Odoo RPC xatosi");
  return j.result;
}

async function createOdooLead(vals) {
  const base = String(process.env.ODOO_URL || "").replace(/\/+$/, "");
  const db = process.env.ODOO_DB;
  const key = process.env.ODOO_API_KEY;

  // 1-urinish: yangi JSON-2 API (Odoo 19 va yangisi)
  const headers = { "Content-Type": "application/json; charset=utf-8", "Authorization": "bearer " + key };
  if (db) headers["X-Odoo-Database"] = db;
  const r = await fetch(base + "/json/2/crm.lead/create", {
    method: "POST",
    headers: headers,
    body: JSON.stringify({ vals_list: [vals] })
  });
  if (r.ok) return;
  if (r.status !== 404) throw new Error("Odoo javobi: " + r.status);

  // 2-urinish: eski JSON-RPC (Odoo 17/18), email + API kalit bilan
  const login = process.env.ODOO_LOGIN;
  if (!login || !db) throw new Error("Eski Odoo uchun ODOO_LOGIN va ODOO_DB kerak");
  const uid = await rpc(base, "common", "authenticate", [db, login, key, {}]);
  if (!uid) throw new Error("Odoo'ga kirib bo'lmadi (email yoki API kalit noto'g'ri)");
  await rpc(base, "object", "execute_kw", [db, uid, key, "crm.lead", "create", [vals]]);
}

async function sendTelegram(text) {
  const r = await fetch("https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text })
  });
  if (!r.ok) throw new Error("Telegram javobi: " + r.status);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Botlar uchun yashirin maydon: odam uni to'ldirmaydi.
  if (body.website) {
    res.status(200).json({ ok: true });
    return;
  }

  const name = String(body.name || "").trim().slice(0, 60);
  const phone = String(body.phone || "").replace(/[^\d+]/g, "").slice(0, 16);
  if (name.length < 2 || phone.replace(/\D/g, "").length < 9) {
    res.status(400).json({ ok: false });
    return;
  }

  const lines = [];
  let total = 0;
  const items = body.items && typeof body.items === "object" ? body.items : {};
  Object.keys(items).forEach((id) => {
    const p = PRODUCTS[id];
    const q = Math.floor(Number(items[id]));
    if (!p || !(q > 0) || q > 20) return;
    total += p.price * q;
    lines.push(p.name + " × " + q + " = " + fmt(p.price * q) + " so'm");
  });
  const cartText = lines.length ? lines.join("\n") + "\nJami: " + fmt(total) + " so'm" : "Savat bo'sh (faqat ro'yxatdan o'tdi)";

  const odooReady = !!(process.env.ODOO_URL && process.env.ODOO_API_KEY);
  const tgReady = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  if (!odooReady && !tgReady) {
    res.status(500).json({ ok: false });
    return;
  }

  const tasks = [];
  if (odooReady) {
    tasks.push(createOdooLead({
      name: "Sayt: " + name + (lines.length ? " (" + fmt(total) + " so'm)" : ""),
      contact_name: name,
      phone: phone,
      description: "<p>Quyosh Vita saytidan kelgan so'rov.</p><p>" + esc(cartText).replace(/\n/g, "<br/>") + "</p>"
    }).catch((e) => { console.error("Odoo xatosi:", e.message); throw e; }));
  }
  if (tgReady) {
    tasks.push(sendTelegram("Yangi so'rov (Quyosh Vita)\nIsm: " + name + "\nTelefon: " + phone + "\n" + cartText)
      .catch((e) => { console.error("Telegram xatosi:", e.message); throw e; }));
  }

  // Kamida bittasi muvaffaqiyatli bo'lsa, mijozga "qabul qilindi" deymiz.
  const results = await Promise.allSettled(tasks);
  const okAny = results.some((x) => x.status === "fulfilled");
  res.status(okAny ? 200 : 502).json({ ok: okAny });
};
