-- Projeto informa se o veículo tem seguro (franquia/seguradora só valem quando true).
ALTER TABLE "ServiceOrder" ADD COLUMN "hasInsurance" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ServiceOrder" SET "hasInsurance" = true WHERE "insuranceCompanyId" IS NOT NULL OR "deductibleAmount" IS NOT NULL;
