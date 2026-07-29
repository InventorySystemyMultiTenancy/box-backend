-- Admin inventory, problem part usage, and financial ledger.

ALTER TABLE "Approval" ADD COLUMN "laborValue" DOUBLE PRECISION;
ALTER TABLE "Approval" ADD COLUMN "partsValue" DOUBLE PRECISION;
ALTER TABLE "Approval" ADD COLUMN "stockAppliedAt" TIMESTAMP(3);

CREATE TABLE "InventoryPart" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "stockQty" INTEGER NOT NULL DEFAULT 0,
    "photoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryPart_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryPart_sku_key" ON "InventoryPart"("sku");

CREATE TABLE "ProblemPartUsage" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "inventoryPartId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostSnapshot" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemPartUsage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProblemPartUsage" ADD CONSTRAINT "ProblemPartUsage_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProblemPartUsage" ADD CONSTRAINT "ProblemPartUsage_inventoryPartId_fkey" FOREIGN KEY ("inventoryPartId") REFERENCES "InventoryPart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FinancialEntry" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "serviceOrderId" TEXT,
    "approvalId" TEXT,
    "inventoryPartId" TEXT,
    "partUsageId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialEntry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "ServiceOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_inventoryPartId_fkey" FOREIGN KEY ("inventoryPartId") REFERENCES "InventoryPart"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_partUsageId_fkey" FOREIGN KEY ("partUsageId") REFERENCES "ProblemPartUsage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
