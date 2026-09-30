-- CreateTable
CREATE TABLE "ServiceOrderShareLink" (
    "id" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceOrderShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOrderShareLink_serviceOrderId_key" ON "ServiceOrderShareLink"("serviceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOrderShareLink_token_key" ON "ServiceOrderShareLink"("token");

-- AddForeignKey
ALTER TABLE "ServiceOrderShareLink" ADD CONSTRAINT "ServiceOrderShareLink_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "ServiceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceOrderShareLink" ADD CONSTRAINT "ServiceOrderShareLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
