-- Valores em dinheiro: double precision -> NUMERIC(12,2) (exato em centavos; o cast arredonda
-- valores antigos como 10.000000001 para 10.00). Preco por litro com 3 casas.
-- Usuario ativo/desativado, tokens de redefinicao de senha, assinatura do cliente e indices.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Commission" ALTER COLUMN "baseAmount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "BankAccount" ALTER COLUMN "initialBalance" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "AccountPayable" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "paidAmount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "AccountReceivable" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "receivedAmount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "discountAmount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "taxAmount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "CounterSale" ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "CounterSaleItem" ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ALTER COLUMN "unitCost" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "InventoryPart" ALTER COLUMN "unitCost" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "ServiceOrder" ALTER COLUMN "estimatedMin" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "estimatedMax" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "deliveryExtraValue" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "deductibleAmount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "QuoteRequest" ALTER COLUMN "initialValue" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Approval" ALTER COLUMN "laborValue" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "partsValue" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "estimatedValue" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "ProblemPartUsage" ALTER COLUMN "unitCostSnapshot" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "FinancialEntry" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "signatureKind" TEXT;

-- AlterTable
ALTER TABLE "Estimate" ALTER COLUMN "laborTotal" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "partsTotal" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "materialsTotal" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "thirdPartyTotal" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "discountAmount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "taxAmount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "deductibleAmount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "EstimateItem" ALTER COLUMN "unitValue" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "totalValue" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Service" ALTER COLUMN "hourlyRate" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "standardPrice" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "TruckRefueling" ALTER COLUMN "amountPaid" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "pricePerLiter" SET DATA TYPE DECIMAL(12,3);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "AccountPayable_status_dueDate_idx" ON "AccountPayable"("status", "dueDate");

-- CreateIndex
CREATE INDEX "AccountReceivable_status_dueDate_idx" ON "AccountReceivable"("status", "dueDate");

-- CreateIndex
CREATE INDEX "AccountReceivable_serviceOrderId_idx" ON "AccountReceivable"("serviceOrderId");

-- CreateIndex
CREATE INDEX "Appointment_startAt_idx" ON "Appointment"("startAt");

-- CreateIndex
CREATE INDEX "Vehicle_ownerId_idx" ON "Vehicle"("ownerId");

-- CreateIndex
CREATE INDEX "ServiceOrder_vehicleId_idx" ON "ServiceOrder"("vehicleId");

-- CreateIndex
CREATE INDEX "ServiceOrder_status_archivedAt_idx" ON "ServiceOrder"("status", "archivedAt");

-- CreateIndex
CREATE INDEX "ServiceOrder_createdAt_idx" ON "ServiceOrder"("createdAt");

-- CreateIndex
CREATE INDEX "QuoteRequest_customerId_idx" ON "QuoteRequest"("customerId");

-- CreateIndex
CREATE INDEX "QuoteRequest_status_idx" ON "QuoteRequest"("status");

-- CreateIndex
CREATE INDEX "TimelineEvent_serviceOrderId_idx" ON "TimelineEvent"("serviceOrderId");

-- CreateIndex
CREATE INDEX "Approval_serviceOrderId_idx" ON "Approval"("serviceOrderId");

-- CreateIndex
CREATE INDEX "Approval_partId_idx" ON "Approval"("partId");

-- CreateIndex
CREATE INDEX "ProblemPartUsage_approvalId_idx" ON "ProblemPartUsage"("approvalId");

-- CreateIndex
CREATE INDEX "FinancialEntry_occurredAt_idx" ON "FinancialEntry"("occurredAt");

-- CreateIndex
CREATE INDEX "FinancialEntry_serviceOrderId_idx" ON "FinancialEntry"("serviceOrderId");

-- CreateIndex
CREATE INDEX "Media_serviceOrderId_idx" ON "Media"("serviceOrderId");

-- CreateIndex
CREATE INDEX "ChatMessage_serviceOrderId_idx" ON "ChatMessage"("serviceOrderId");

-- CreateIndex
CREATE INDEX "Notification_read_idx" ON "Notification"("read");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

