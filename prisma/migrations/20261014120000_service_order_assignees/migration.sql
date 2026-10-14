-- CreateTable
CREATE TABLE "ServiceOrderAssignee" (
    "id" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceOrderAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceOrderAssignee_userId_idx" ON "ServiceOrderAssignee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOrderAssignee_serviceOrderId_userId_key" ON "ServiceOrderAssignee"("serviceOrderId", "userId");

-- AddForeignKey
ALTER TABLE "ServiceOrderAssignee" ADD CONSTRAINT "ServiceOrderAssignee_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "ServiceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceOrderAssignee" ADD CONSTRAINT "ServiceOrderAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: funcionários (não-admin) que já trabalhavam no projeto continuam enxergando-o —
-- técnico/consultor/orçamentista definidos no processo e responsáveis por algum reparo.
INSERT INTO "ServiceOrderAssignee" ("id", "serviceOrderId", "userId")
SELECT gen_random_uuid()::text, pairs."serviceOrderId", pairs."userId"
FROM (
    SELECT "id" AS "serviceOrderId", "technicianId" AS "userId" FROM "ServiceOrder" WHERE "technicianId" IS NOT NULL
    UNION
    SELECT "id", "consultantId" FROM "ServiceOrder" WHERE "consultantId" IS NOT NULL
    UNION
    SELECT "id", "estimatorId" FROM "ServiceOrder" WHERE "estimatorId" IS NOT NULL
    UNION
    SELECT "serviceOrderId", "responsibleId" FROM "VehiclePart" WHERE "responsibleId" IS NOT NULL
) AS pairs
JOIN "User" u ON u."id" = pairs."userId" AND u."role" = 'MECHANIC';
