-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "driverId" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'SERVICE';

-- AlterTable
ALTER TABLE "FinancialEntry" ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "isDamagePhoto" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "allowedTabs" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "TruckTrip" ADD COLUMN     "appointmentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TruckTrip_appointmentId_key" ON "TruckTrip"("appointmentId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckTrip" ADD CONSTRAINT "TruckTrip_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DataMigration: as etapas AWAITING_APPROVAL/PARTS_REQUESTED/PARTS_RECEIVED/WASHING
-- saem do fluxo ativo (Kanban e "Avançar etapa") — qualquer projeto que ainda esteja
-- num desses status é reclassificado para o status ativo mais próximo, sem perder
-- histórico (timeline/aprovações/peças continuam intactos, só o campo status muda).
UPDATE "ServiceOrder" SET status = 'IN_PROGRESS', progress = GREATEST(progress, 65)
  WHERE status IN ('AWAITING_APPROVAL', 'PARTS_REQUESTED', 'PARTS_RECEIVED');

UPDATE "ServiceOrder" SET status = 'FINISHED', progress = GREATEST(progress, 97)
  WHERE status = 'WASHING';
