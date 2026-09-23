/*
  Warnings:

  - You are about to drop the column `storeId` on the `AccountPayable` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "AccountPayable" DROP CONSTRAINT "AccountPayable_storeId_fkey";

-- DropForeignKey
ALTER TABLE "Commission" DROP CONSTRAINT "Commission_approvalId_fkey";

-- AlterTable
ALTER TABLE "AccountPayable" DROP COLUMN "storeId";

-- AlterTable
ALTER TABLE "Commission" ADD COLUMN     "basisType" TEXT NOT NULL DEFAULT 'APPROVAL',
ALTER COLUMN "approvalId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "FinancialEntry" ADD COLUMN     "counterSaleId" TEXT;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_counterSaleId_fkey" FOREIGN KEY ("counterSaleId") REFERENCES "CounterSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
