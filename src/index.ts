import express, { type NextFunction, type Request, type Response } from "express";
import { createClient } from "@libsql/client";
import crypto from "node:crypto";

// ---------- Config ----------
const PORT = Number(process.env.PORT ?? 3000);
const PAWA_URL = process.env.PAWAPAY_BASE_URL ?? "https://api.sandbox.pawapay.io";
const PAWA_TOKEN = process.env.PAWAPAY_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

type Project = { name: string; apiKey: string; webhookUrl?: string };
const projects: Project[] = JSON.parse(process.env.PROJECTS ?? "[]");

if (!PAWA_TOKEN) throw new Error("PAWAPAY_TOKEN manquant");
if (!projects.length) throw new Error("PROJECTS manquant ou vide");

const db = createClient({
  url: process.env.DATABASE_URL ?? "file:payments.db",
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

await db.execute(`
  CREATE TABLE IF NOT EXISTS payments (
    deposit_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    provider TEXT NOT NULL,
    phone_masked TEXT NOT NULL,
    client_reference_id TEXT,
    status TEXT NOT NULL,            -- PENDING | COMPLETED | FAILED
    provider_status TEXT,            -- statut brut pawaPay
    failure_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    notified_at INTEGER
  )
`);

// ---------- Helpers ----------
const safeEqual = (a: string, b: string) => {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

async function pawa(path: string, init?: RequestInit) {
  const r = await fetch(PAWA_URL + path, {
    ...init,
    headers: { Authorization: `Bearer ${PAWA_TOKEN}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  return { httpStatus: r.status, body: (await r.json().catch(() => null)) as any };
}

async function getPayment(id: string) {
  const r = await db.execute({ sql: "SELECT * FROM payments WHERE deposit_id = ?", args: [id] });
  return r.rows[0] as any | undefined;
}

const publicView = (p: any) => ({
  depositId: p.deposit_id,
  status: p.status,
  amount: p.amount,
  currency: p.currency,
  provider: p.provider,
  clientReferenceId: p.client_reference_id,
  failureReason: p.failure_reason ? JSON.parse(p.failure_reason) : null,
  createdAt: new Date(Number(p.created_at)).toISOString(),
});

// Previent l'app du projet (webhook signe HMAC-SHA256 dans l'en-tete X-Signature)
async function notify(id: string) {
  const p = await getPayment(id);
  if (!p || p.status === "PENDING" || p.notified_at) return;
  const project = projects.find((x) => x.name === p.project);
  if (project?.webhookUrl) {
    const body = JSON.stringify({ event: "payment.updated", sentAt: new Date().toISOString(), ...publicView(p) });
    const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    try {
      const r = await fetch(project.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature": signature },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return; // sera retente par la routine de rattrapage
    } catch {
      return;
    }
  }
  await db.execute({ sql: "UPDATE payments SET notified_at = ? WHERE deposit_id = ?", args: [Date.now(), id] });
}

// Demande TOUJOURS le statut reel a pawaPay (on ne fait jamais confiance au corps du callback)
async function syncFromPawa(id: string) {
  const p = await getPayment(id);
  if (!p) return;
  const { body } = await pawa(`/v2/deposits/${encodeURIComponent(id)}`);
  const now = Date.now();

  if (body?.status === "FOUND") {
    const s: string = body.data.status;
    const status = s === "COMPLETED" || s === "FAILED" ? s : "PENDING";
    const failure = body.data.failureReason ? JSON.stringify(body.data.failureReason) : null;
    await db.execute({
      sql: "UPDATE payments SET status=?, provider_status=?, failure_reason=COALESCE(?, failure_reason), updated_at=? WHERE deposit_id=?",
      args: [status, s, failure, now, id],
    });
  } else if (body?.status === "NOT_FOUND" && now - Number(p.created_at) > 5 * 60_000) {
    await db.execute({
      sql: "UPDATE payments SET status='FAILED', provider_status='NOT_FOUND', updated_at=? WHERE deposit_id=?",
      args: [now, id],
    });
  }
  await notify(id);
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "50kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Callback appele par pawaPay (configure dans le dashboard, champ "Depots")
app.post("/pawapay/callback", (req, res) => {
  res.sendStatus(200);
  const id = req.body?.depositId;
  if (typeof id === "string") syncFromPawa(id).catch((e) => console.error("callback:", e));
});

// Tout ce qui suit demande une cle API de projet
const auth = (req: Request, res: Response, next: NextFunction) => {
  const key = req.header("x-api-key") ?? "";
  const project = projects.find((p) => safeEqual(p.apiKey, key));
  if (!project) return res.status(401).json({ error: "invalid_api_key" });
  res.locals.project = project;
  next();
};

// Creer un paiement
app.post("/payments", auth, async (req, res) => {
  const project: Project = res.locals.project;
  const { amount, currency, phoneNumber, provider, clientReferenceId, customerMessage } = req.body ?? {};

  const amountStr = String(amount ?? "");
  const phone = String(phoneNumber ?? "").replace(/[\s+]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(amountStr) || Number(amountStr) <= 0)
    return res.status(400).json({ error: "invalid_amount" });
  if (!/^[A-Z]{3}$/.test(String(currency ?? ""))) return res.status(400).json({ error: "invalid_currency" });
  if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: "invalid_phone_number" });
  if (!/^[A-Z0-9_]+$/.test(String(provider ?? ""))) return res.status(400).json({ error: "invalid_provider" });
  if (customerMessage != null && !/^.{4,22}$/.test(String(customerMessage)))
    return res.status(400).json({ error: "invalid_customer_message" });

  const depositId = crypto.randomUUID();
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO payments (deposit_id, project, amount, currency, provider, phone_masked,
            client_reference_id, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?, 'PENDING', ?, ?)`,
    args: [depositId, project.name, amountStr, currency, provider, `***${phone.slice(-4)}`,
           clientReferenceId ? String(clientReferenceId).slice(0, 100) : null, now, now],
  });

  try {
    const { body } = await pawa("/v2/deposits", {
      method: "POST",
      body: JSON.stringify({
        depositId,
        amount: amountStr,
        currency,
        payer: { type: "MMO", accountDetails: { phoneNumber: phone, provider } },
        ...(clientReferenceId ? { clientReferenceId: String(clientReferenceId).slice(0, 100) } : {}),
        ...(customerMessage ? { customerMessage: String(customerMessage) } : {}),
      }),
    });
    if (body?.status === "REJECTED") {
      await db.execute({
        sql: "UPDATE payments SET status='FAILED', provider_status='REJECTED', failure_reason=?, updated_at=? WHERE deposit_id=?",
        args: [JSON.stringify(body.failureReason ?? null), Date.now(), depositId],
      });
    }
  } catch (e) {
    // Reseau incertain : le paiement reste PENDING, la routine de rattrapage verifiera aupres de pawaPay
    console.error("pawapay init:", e);
  }

  const p = await getPayment(depositId);
  res.status(p.status === "FAILED" ? 422 : 201).json(publicView(p));
});

// Lire le statut d'un paiement (uniquement ceux de ton projet)
app.get("/payments/:id", auth, async (req, res) => {
  const project: Project = res.locals.project;
  let p = await getPayment(req.params.id);
  if (!p || p.project !== project.name) return res.status(404).json({ error: "not_found" });
  if (p.status === "PENDING") {
    await syncFromPawa(p.deposit_id).catch(() => {});
    p = await getPayment(req.params.id);
  }
  res.json(publicView(p));
});

// Rattrapage chaque minute : callbacks perdus + webhooks non livres
setInterval(async () => {
  try {
    const pending = await db.execute({
      sql: "SELECT deposit_id FROM payments WHERE status='PENDING' AND created_at < ?",
      args: [Date.now() - 2 * 60_000],
    });
    for (const r of pending.rows) await syncFromPawa(String(r.deposit_id));
    const unnotified = await db.execute("SELECT deposit_id FROM payments WHERE status != 'PENDING' AND notified_at IS NULL");
    for (const r of unnotified.rows) await notify(String(r.deposit_id));
  } catch (e) {
    console.error("sweep:", e);
  }
}, 60_000);

app.listen(PORT, () => console.log(`payments-api sur le port ${PORT} (${PAWA_URL})`));
