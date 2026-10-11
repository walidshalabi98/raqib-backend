# Security setup (Phase 0)

What changed in Phase 0 and what to do once per environment.

## 1. Environment variables

The server now refuses to start when required settings are missing or weak, and prints which ones:

| Variable | Rule |
|---|---|
| `DATABASE_URL` | required |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | required, at least 32 characters each (`openssl rand -hex 32`) |
| `ANTHROPIC_API_KEY` | required |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | required in production (document storage) |
| `CORS_ORIGINS` | extra browser origins, comma-separated; `APP_URL` is always allowed |

Changing `JWT_SECRET` signs everyone out once. See `.env.example` for the full list.

## 2. Document storage

Documents are no longer served from a public `/uploads` folder.

- **Production / staging:** files go to a private Supabase Storage bucket (`SUPABASE_STORAGE_BUCKET`, default `documents`). Create it once with `npm run storage:setup` (it refuses to continue if the bucket is public).
- **Local development:** without Supabase settings, files are kept in `LOCAL_STORAGE_DIR` (default `storage/`, git-ignored) and are never served statically.
- **Downloading:** `GET /api/documents/:id/download` checks that the user belongs to the document's organisation and returns `{ url, fileName, expiresAt }`. The URL works for 5 minutes.
- **Existing files:** documents uploaded before Phase 0 still point at `/uploads/...`. Run `npm run storage:migrate` to see what would move, then `npm run storage:migrate -- --apply` to copy them into the bucket. Delete the old `uploads/` folder only after checking downloads work.

Uploads are limited to 25 MB and to PDF, Word (`.docx`, `.doc`) and Excel (`.xlsx`) files. The file content must match its extension. Legacy `.xls` files are no longer accepted (the old spreadsheet library had unfixed security issues); save them as `.xlsx`.

## 3. Webhooks (KoboToolbox, Manasati)

Every webhook call needs an organisation webhook token, and can only write to that organisation's projects.

1. An org admin creates a token: `POST /api/organizations/:orgId/webhook-tokens`. The response contains the token **once**; only a hash is stored. Data imported through the token is attributed to the admin who created it.
2. In KoboToolbox: *Project → Settings → REST Services → Register a new service*, endpoint `https://<api-host>/api/webhooks/kobotoolbox`, and add a custom HTTP header `X-Raqib-Webhook-Token: <token>`.
3. Optional signing: senders that can sign requests add `X-Raqib-Signature: sha256=<hex HMAC-SHA256 of the raw body>` using `WEBHOOK_SECRET`. A signature that is present must be valid.
4. List tokens with `GET /api/organizations/:orgId/webhook-tokens`; revoke with `DELETE /api/organizations/:orgId/webhook-tokens/:tokenId`.

Rejected calls are logged as `[Webhook] Rejected {...}` with the reason and IP, never the token.

## 4. Database change

Phase 0 adds one table, `WebhookToken`. The reviewed SQL is in `prisma/sql/2026-10-11_phase0_webhook_tokens.sql` (additive only, and it enables row level security on the new table so Supabase's public API cannot read it). Apply it to a Supabase development branch first, then to the shared database.

## 5. Other protections

- Security headers (`helmet`), CORS limited to configured origins.
- Rate limits: 300 requests/minute per IP overall; 30 per 15 minutes on `/api/auth/*`; 60 AI requests/hour per user; 120 webhook calls/minute per IP.
- Every route that takes an id checks the caller's organisation through `src/middleware/access.ts`; other organisations' records answer 404. Ids passed in a request body (indicator, assessment) must belong to the same project.
- Org admins can no longer grant the `platform_admin` role.
- The seed refuses to run in production and needs `SEED_PASSWORD` outside development.

## 6. Tests

```bash
# Unit tests run anywhere; integration tests need a disposable Postgres with pgvector
# whose database name contains "test" (all data in it is deleted).
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/raqib_test npx prisma db push --skip-generate
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/raqib_test npm test
```

`tests/isolation.test.ts` lists every route that takes an id and fails if a new one is added without an isolation check.
