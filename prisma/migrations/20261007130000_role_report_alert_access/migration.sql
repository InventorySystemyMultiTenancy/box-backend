-- Acesso por cargo: blocos da aba Relatorios, setores de despesa cujos numeros o cargo ve
-- e tipos de alerta visiveis. Lista vazia = sem restricao (comportamento anterior).
ALTER TABLE "Role" ADD COLUMN     "alertTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "expenseSectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reportSections" TEXT[] DEFAULT ARRAY[]::TEXT[];
