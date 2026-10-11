-- Phase 0: webhook tokens (additive only; no existing table or column is changed).
-- Generated with: prisma migrate diff --from-schema-datamodel <main> --to-schema-datamodel prisma/schema.prisma --script
-- Review, run on a Supabase development branch first, then apply to the shared database.
-- CreateTable
CREATE TABLE "WebhookToken" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookToken_tokenHash_key" ON "WebhookToken"("tokenHash");

-- CreateIndex
CREATE INDEX "WebhookToken_organizationId_idx" ON "WebhookToken"("organizationId");

-- AddForeignKey
ALTER TABLE "WebhookToken" ADD CONSTRAINT "WebhookToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookToken" ADD CONSTRAINT "WebhookToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Supabase exposes the public schema through its Data API. Enable RLS (with no policies)
-- so token hashes are never readable with the anon key. Prisma connects as the table owner and is unaffected.
ALTER TABLE "WebhookToken" ENABLE ROW LEVEL SECURITY;
