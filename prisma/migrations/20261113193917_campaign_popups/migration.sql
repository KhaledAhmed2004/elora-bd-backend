-- CreateEnum
CREATE TYPE "PopupLayout" AS ENUM ('IMAGE', 'SPLIT', 'TEXT');

-- CreateEnum
CREATE TYPE "PopupTrigger" AS ENUM ('ON_LOAD', 'DELAY', 'SCROLL', 'EXIT_INTENT');

-- CreateEnum
CREATE TYPE "PopupFrequency" AS ENUM ('ONCE', 'DAILY', 'SESSION', 'ALWAYS');

-- CreateEnum
CREATE TYPE "PopupPages" AS ENUM ('ALL', 'HOME', 'SHOPPING');

-- CreateEnum
CREATE TYPE "PopupDevice" AS ENUM ('ALL', 'MOBILE', 'DESKTOP');

-- CreateTable
CREATE TABLE "popups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "badge" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "image" TEXT,
    "cta" TEXT,
    "href" TEXT,
    "couponCode" TEXT,
    "layout" "PopupLayout" NOT NULL DEFAULT 'SPLIT',
    "trigger" "PopupTrigger" NOT NULL DEFAULT 'DELAY',
    "delaySeconds" INTEGER NOT NULL DEFAULT 5,
    "scrollPercent" INTEGER NOT NULL DEFAULT 40,
    "frequency" "PopupFrequency" NOT NULL DEFAULT 'DAILY',
    "pages" "PopupPages" NOT NULL DEFAULT 'ALL',
    "device" "PopupDevice" NOT NULL DEFAULT 'ALL',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "showCountdown" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "popups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "popups_active_endsAt_idx" ON "popups"("active", "endsAt");
