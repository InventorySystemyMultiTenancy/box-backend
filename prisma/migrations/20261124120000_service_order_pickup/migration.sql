-- Confirmação de que o veículo pronto já saiu da empresa ("Confirmar retirada"): data,
-- descrição digitada e quem confirmou. Só adiciona colunas.
ALTER TABLE "ServiceOrder" ADD COLUMN "pickedUpAt" TIMESTAMP(3);
ALTER TABLE "ServiceOrder" ADD COLUMN "pickupDescription" TEXT;
ALTER TABLE "ServiceOrder" ADD COLUMN "pickupConfirmedByName" TEXT;
