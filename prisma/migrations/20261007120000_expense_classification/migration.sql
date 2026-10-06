-- Classificacao de despesas (formulario de contas a pagar estilo "Cadastrar contas a Pagar"):
-- grupo, descricao, setor de origem, dados do documento, empresa e responsavel pelo lancamento;
-- nota fiscal de despesa com classificacao e banco associado; cadastro das classificacoes salvas.

-- AlterTable
ALTER TABLE "AccountPayable" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "documentNumber" TEXT,
ADD COLUMN     "expenseDescription" TEXT,
ADD COLUMN     "expenseGroup" TEXT,
ADD COLUMN     "expenseSector" TEXT,
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "issueDate" TIMESTAMP(3),
ADD COLUMN     "storeId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "expenseDescription" TEXT,
ADD COLUMN     "expenseGroup" TEXT,
ADD COLUMN     "expenseSector" TEXT;

-- CreateTable
CREATE TABLE "ExpenseClassification" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseClassification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseClassification_kind_parentName_name_key" ON "ExpenseClassification"("kind", "parentName", "name");

-- CreateIndex
CREATE INDEX "AccountPayable_expenseSector_idx" ON "AccountPayable"("expenseSector");

-- AddForeignKey
ALTER TABLE "AccountPayable" ADD CONSTRAINT "AccountPayable_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayable" ADD CONSTRAINT "AccountPayable_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Aproveita as categorias ja usadas como ponto de partida do cadastro (contas a pagar,
-- natureza da operacao das notas e categorias de gastos lancados na aba Gastos).
INSERT INTO "ExpenseClassification" ("id", "kind", "name", "parentName")
SELECT md5('CATEGORY' || name), 'CATEGORY', name, ''
FROM (
  SELECT DISTINCT trim("category") AS name FROM "AccountPayable" WHERE trim("category") <> ''
  UNION
  SELECT DISTINCT trim("operationNature") FROM "Invoice" WHERE "operationNature" IS NOT NULL AND trim("operationNature") <> ''
  UNION
  SELECT DISTINCT trim("category") FROM "FinancialEntry" WHERE "type" = 'EXPENSE' AND trim("category") <> ''
) AS existing
ON CONFLICT ("kind", "parentName", "name") DO NOTHING;