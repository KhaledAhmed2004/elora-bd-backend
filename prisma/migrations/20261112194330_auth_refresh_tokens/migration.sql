/*
  Warnings:

  - You are about to drop the `admin_sessions` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "admin_sessions" DROP CONSTRAINT "admin_sessions_adminId_fkey";

-- DropTable
DROP TABLE "admin_sessions";

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claims" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "familyExpiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revoked_token_families" (
    "familyId" TEXT NOT NULL,
    "familyExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_token_families_pkey" PRIMARY KEY ("familyId")
);

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyExpiresAt_idx" ON "refresh_tokens"("familyExpiresAt");

-- CreateIndex
CREATE INDEX "revoked_token_families_familyExpiresAt_idx" ON "revoked_token_families"("familyExpiresAt");
