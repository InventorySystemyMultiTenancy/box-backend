-- Diagnóstico único do projeto: pontos que a IA marcou no modelo do veículo a partir da
-- descrição (posição + trecho da descrição + motivo). Só adiciona coluna (nada muda nos
-- problemas antigos).
ALTER TABLE "VehiclePart" ADD COLUMN "aiSpots" JSONB;
