-- Conta a receber de projeto com seguro: valor bruto do projeto e franquia descontada.
ALTER TABLE "AccountReceivable" ADD COLUMN "orderGrossAmount" DECIMAL(12,2);
ALTER TABLE "AccountReceivable" ADD COLUMN "deductibleAmount" DECIMAL(12,2);

-- Projetos com franquia já cobrados (conta única, ainda não recebida e sem nota): aplica o
-- desconto da franquia na conta existente.
UPDATE "AccountReceivable" ar
SET "orderGrossAmount" = ar."amount",
    "deductibleAmount" = so."deductibleAmount",
    "amount" = ar."amount" - so."deductibleAmount"
FROM "ServiceOrder" so
WHERE ar."serviceOrderId" = so."id"
  AND so."hasInsurance" = true
  AND so."deductibleAmount" > 0
  AND ar."category" = 'SERVIÇO'
  AND ar."status" IN ('PENDING', 'OVERDUE')
  AND ar."installmentTotal" IS NULL
  AND ar."deductibleAmount" IS NULL
  AND ar."description" NOT LIKE '%(valor extra na entrega)'
  AND ar."amount" > so."deductibleAmount"
  AND NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i."accountReceivableId" = ar."id")
  AND (SELECT COUNT(*) FROM "AccountReceivable" o WHERE o."serviceOrderId" = so."id" AND o."status" <> 'CANCELLED') = 1;
