# payments-api

Petit backend de paiement mobile money (pawaPay) reutilisable par tous tes projets.

## Demarrer en local

```bash
npm install
cp .env.example .env      # puis remplis PAWAPAY_TOKEN, WEBHOOK_SECRET, PROJECTS
npm run dev
```

Pour recevoir les callbacks en local, expose le port avec ngrok, puis mets
`https://xxxx.ngrok.app/pawapay/callback` dans le dashboard pawaPay (Developpeurs > URL de rappel > Depots).

## Mise en ligne

Deploie n'importe ou (Docker fourni : Railway, Render, Fly.io, AWS App Runner...).
Definis les variables d'environnement de `.env.example` sur l'hebergeur, en HTTPS.

- Sandbox : `PAWAPAY_BASE_URL=https://api.sandbox.pawapay.io`
- Production : `PAWAPAY_BASE_URL=https://api.pawapay.io` + jeton de production
- Base de donnees : `DATABASE_URL=file:payments.db` marche pour tester, mais un disque
  d'hebergeur est souvent efface a chaque deploiement. En ligne, utilise Turso :
  `DATABASE_URL=libsql://ta-base.turso.io` et `DATABASE_AUTH_TOKEN=...`

## Ajouter un projet

Dans la variable `PROJECTS`, ajoute un objet par app :

```json
[{"name":"mon-blog","apiKey":"cle-longue-aleatoire","webhookUrl":"https://mon-blog.com/api/payment-webhook"}]
```

Genere une cle : `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`

## API

Toutes les routes (sauf `/health` et le callback) demandent l'en-tete `x-api-key`.
Appelle-les depuis ton **backend**, jamais depuis le navigateur (la cle deviendrait publique).

### POST /payments

```bash
curl -X POST https://ton-api.com/payments \
  -H "x-api-key: TA_CLE" -H "Content-Type: application/json" \
  -d '{"amount":"100","currency":"RWF","phoneNumber":"250783456789","provider":"MTN_MOMO_RWA","clientReferenceId":"CMD-123"}'
```

Reponse `201` : `{ "depositId": "...", "status": "PENDING", ... }`.
Le client valide sur son telephone (code PIN).

### GET /payments/:depositId

Renvoie `status` : `PENDING`, `COMPLETED` ou `FAILED` (avec `failureReason`).

### Notification vers ton app

Quand le paiement est termine, l'API envoie un POST a `webhookUrl` avec le meme JSON que
GET /payments, et l'en-tete `X-Signature` = HMAC-SHA256 hex du corps brut avec `WEBHOOK_SECRET`.
Verifie-la, puis debloque l'acces uniquement si `status === "COMPLETED"`.

```ts
import crypto from "node:crypto";
const expected = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET!).update(rawBody).digest("hex");
if (expected !== req.headers["x-signature"]) return res.sendStatus(401);
```

Si ton app est indisponible, la notification est retentee chaque minute.

## Securite

- Le corps du callback pawaPay n'est jamais cru : l'API redemande le statut a pawaPay.
- Les numeros de telephone ne sont stockes que masques (`***1234`).
- Ajoute un limiteur de debit (ex. `express-rate-limit`) si l'API devient publique.
