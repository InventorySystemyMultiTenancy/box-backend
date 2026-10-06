import { Prisma, PrismaClient } from "@prisma/client";
import type { ITXClientDenyList } from "@prisma/client/runtime/library";

// Campos de dinheiro ficam como NUMERIC(12,2) no banco (exatos em centavos — ver migration
// 20261006130000_money_decimal_users_signatures_indexes), mas o resto do código e o
// frontend continuam trabalhando com `number`: a extensão abaixo converte cada um deles
// de Prisma.Decimal pra number na leitura, inclusive em relações aninhadas (include).
// Ao adicionar um novo campo Decimal no schema, inclua-o aqui também.
export const MONEY_FIELDS = {
  accountPayable: ["amount", "paidAmount"],
  accountReceivable: ["amount", "receivedAmount"],
  invoice: ["totalAmount", "discountAmount", "taxAmount"],
  counterSale: ["totalAmount"],
  counterSaleItem: ["unitPrice"],
  purchaseOrderItem: ["unitCost"],
  bankAccount: ["initialBalance"],
  commission: ["baseAmount", "amount"],
  inventoryPart: ["unitCost"],
  serviceOrder: ["estimatedMin", "estimatedMax", "deliveryExtraValue", "deductibleAmount"],
  quoteRequest: ["initialValue"],
  approval: ["laborValue", "partsValue", "estimatedValue"],
  problemPartUsage: ["unitCostSnapshot"],
  financialEntry: ["amount"],
  estimate: ["laborTotal", "partsTotal", "materialsTotal", "thirdPartyTotal", "discountAmount", "taxAmount", "deductibleAmount", "totalAmount"],
  estimateItem: ["unitValue", "totalValue"],
  service: ["hourlyRate", "standardPrice"],
  truckRefueling: ["amountPaid", "pricePerLiter"],
} as const;

type MoneyFields = typeof MONEY_FIELDS;

/** Decimal (ou null) -> number (ou null). Também usado nos `_sum` de aggregate, que a extensão não cobre. */
export function toNumber(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : value.toNumber();
}

function moneyResult() {
  const result: Record<string, Record<string, { needs: Record<string, true>; compute: (row: Record<string, unknown>) => unknown }>> = {};
  for (const [model, fields] of Object.entries(MONEY_FIELDS)) {
    result[model] = {};
    for (const field of fields) {
      result[model][field] = {
        needs: { [field]: true },
        compute: (row) => toNumber(row[field] as Prisma.Decimal | null),
      };
    }
  }
  return result as {
    [M in keyof MoneyFields]: {
      [F in MoneyFields[M][number]]: { needs: { [K in F]: true }; compute: (row: Record<string, unknown>) => number };
    };
  };
}

function createClient() {
  return new PrismaClient().$extends({ result: moneyResult() });
}

export type AppPrismaClient = ReturnType<typeof createClient>;
/** Client recebido dentro de prisma.$transaction(async (tx) => ...) — já com a extensão de dinheiro. */
export type AppTx = Omit<AppPrismaClient, ITXClientDenyList>;

// Evita múltiplas instâncias do client em hot-reload de dev (tsx watch).
declare global {
  // eslint-disable-next-line no-var
  var __prisma: AppPrismaClient | undefined;
}

export const prisma = global.__prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
