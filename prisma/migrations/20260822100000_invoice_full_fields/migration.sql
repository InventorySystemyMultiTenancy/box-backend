-- Campos completos de nota fiscal (emitente, destinatário, chave de acesso, impostos...)
-- para suportar cadastro manual ou via leitura de imagem por IA.

ALTER TABLE "Invoice" ADD COLUMN     "accessKey" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "operationNature" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "issuerName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "issuerDocument" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "recipientName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "recipientDocument" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "paymentMethod" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "description" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "discountAmount" DOUBLE PRECISION;
ALTER TABLE "Invoice" ADD COLUMN     "taxAmount" DOUBLE PRECISION;
