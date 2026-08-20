-- Observação do mecânico em problemas e extras de entrega do veículo.

ALTER TABLE "Approval" ADD COLUMN "note" TEXT;

ALTER TABLE "ServiceOrder" ADD COLUMN "deliveryDescription" TEXT;
ALTER TABLE "ServiceOrder" ADD COLUMN "deliveryExtraValue" DOUBLE PRECISION;

ALTER TABLE "Media" ADD COLUMN "isDeliveryPhoto" BOOLEAN NOT NULL DEFAULT false;
