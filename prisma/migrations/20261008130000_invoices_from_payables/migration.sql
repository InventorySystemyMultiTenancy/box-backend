-- Contas a pagar lancadas com numero de nota fiscal (formulario "Cadastrar contas a pagar")
-- passam a ter a nota registrada tambem, para aparecer na aba Notas fiscais. Aqui cria as
-- notas das contas que ja existiam: as duplicatas de um mesmo lancamento (mesmo groupId)
-- viram uma nota so, com o valor somado. Contas canceladas ficam de fora. Se ja existir
-- nota ativa com o mesmo numero e fornecedor, as contas sao ligadas a ela.

-- 1) Liga a uma nota ja existente (mesmo numero e fornecedor), quando houver.
UPDATE "AccountPayable" ap
SET "invoiceId" = inv.id
FROM "Invoice" inv
WHERE ap."invoiceId" IS NULL
  AND ap."invoiceNumber" IS NOT NULL
  AND trim(ap."invoiceNumber") <> ''
  AND ap."status" <> 'CANCELLED'
  AND inv."status" <> 'CANCELLED'
  AND lower(inv."number") = lower(trim(ap."invoiceNumber"))
  AND lower(coalesce(inv."issuerName", '')) = lower(trim(ap."payeeName"));

-- 2) Cria uma nota por lancamento (groupId, ou a propria conta quando nao parcelada).
INSERT INTO "Invoice" (
  "id", "type", "status", "number", "provider", "issuerName", "operationNature",
  "paymentMethod", "description", "expenseGroup", "expenseDescription", "expenseSector",
  "bankAccountId", "totalAmount", "issueDate", "createdAt", "updatedAt"
)
SELECT
  md5('payable-invoice-' || grp.key),
  'NFE',
  'ISSUED',
  grp."invoiceNumber",
  'MANUAL',
  grp."payeeName",
  grp."category",
  grp."paymentMethod",
  grp."notes",
  grp."expenseGroup",
  grp."expenseDescription",
  grp."expenseSector",
  grp."bankAccountId",
  grp."totalAmount",
  grp."issueDate",
  grp."createdAt",
  NOW()
FROM (
  SELECT
    coalesce("groupId", "id") AS key,
    min(trim("invoiceNumber")) AS "invoiceNumber",
    min("payeeName") AS "payeeName",
    min("category") AS "category",
    min("paymentMethod") AS "paymentMethod",
    min("notes") AS "notes",
    min("expenseGroup") AS "expenseGroup",
    min("expenseDescription") AS "expenseDescription",
    min("expenseSector") AS "expenseSector",
    min("bankAccountId") AS "bankAccountId",
    sum("amount") AS "totalAmount",
    coalesce(min("issueDate"), min("createdAt")) AS "issueDate",
    min("createdAt") AS "createdAt"
  FROM "AccountPayable"
  WHERE "invoiceId" IS NULL
    AND "invoiceNumber" IS NOT NULL
    AND trim("invoiceNumber") <> ''
    AND "status" <> 'CANCELLED'
  GROUP BY coalesce("groupId", "id")
) AS grp
ON CONFLICT ("id") DO NOTHING;

-- 3) Liga as contas as notas criadas acima.
UPDATE "AccountPayable"
SET "invoiceId" = md5('payable-invoice-' || coalesce("groupId", "id"))
WHERE "invoiceId" IS NULL
  AND "invoiceNumber" IS NOT NULL
  AND trim("invoiceNumber") <> ''
  AND "status" <> 'CANCELLED'
  AND EXISTS (SELECT 1 FROM "Invoice" WHERE "id" = md5('payable-invoice-' || coalesce("AccountPayable"."groupId", "AccountPayable"."id")));
