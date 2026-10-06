-- Sequências dedicadas para os códigos de orçamento (ORC-), pedido de compra (PC-) e
-- venda de balcão (PDV-) — mesmo problema já corrigido na OS (migration
-- 20260928120000_service_order_code_sequence): o cálculo por COUNT(*) colidia com a
-- constraint única de "code" em criações simultâneas ou depois de uma exclusão.
CREATE SEQUENCE IF NOT EXISTS "Estimate_code_seq";
CREATE SEQUENCE IF NOT EXISTS "PurchaseOrder_code_seq";
CREATE SEQUENCE IF NOT EXISTS "CounterSale_code_seq";

-- Alinha cada sequência com o maior número já em uso, pra não colidir com códigos existentes.
DO $$
DECLARE
  max_seq integer;
BEGIN
  SELECT COALESCE(MAX(CAST(regexp_replace("code", '^ORC-\d{4}-', '') AS integer)), 0)
  INTO max_seq FROM "Estimate" WHERE "code" ~ '^ORC-\d{4}-\d+$';
  PERFORM setval('"Estimate_code_seq"', GREATEST(max_seq, 1), max_seq > 0);

  SELECT COALESCE(MAX(CAST(regexp_replace("code", '^PC-\d{4}-', '') AS integer)), 0)
  INTO max_seq FROM "PurchaseOrder" WHERE "code" ~ '^PC-\d{4}-\d+$';
  PERFORM setval('"PurchaseOrder_code_seq"', GREATEST(max_seq, 1), max_seq > 0);

  SELECT COALESCE(MAX(CAST(regexp_replace("code", '^PDV-\d{4}-', '') AS integer)), 0)
  INTO max_seq FROM "CounterSale" WHERE "code" ~ '^PDV-\d{4}-\d+$';
  PERFORM setval('"CounterSale_code_seq"', GREATEST(max_seq, 1), max_seq > 0);
END $$;
