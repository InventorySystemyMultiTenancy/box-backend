-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "partId" TEXT;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_partId_fkey" FOREIGN KEY ("partId") REFERENCES "VehiclePart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

