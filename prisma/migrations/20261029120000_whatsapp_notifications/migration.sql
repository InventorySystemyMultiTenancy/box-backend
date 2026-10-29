-- CreateTable
CREATE TABLE "WhatsappMessage" (
    "id" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipientName" TEXT,
    "phone" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappOptOut" (
    "phoneKey" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappOptOut_pkey" PRIMARY KEY ("phoneKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappMessage_serviceOrderId_kind_phoneKey_key" ON "WhatsappMessage"("serviceOrderId", "kind", "phoneKey");

-- CreateIndex
CREATE INDEX "WhatsappMessage_status_createdAt_idx" ON "WhatsappMessage"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsappMessage_phoneKey_idx" ON "WhatsappMessage"("phoneKey");
