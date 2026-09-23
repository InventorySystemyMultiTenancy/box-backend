import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";
import { nextCounterSaleCode } from "@/lib/counter-sale-code";

export class CounterSaleError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface CounterSaleItemInput {
  inventoryPartId: string;
  quantity: number;
  unitPrice: number;
}

export interface CounterSaleInput {
  clientId?: string;
  customerName?: string;
  paymentMethod?: string;
  bankAccountId?: string;
  storeId?: string;
  items: CounterSaleItemInput[];
}

const include = {
  client: true,
  bankAccount: true,
  items: { include: { inventoryPart: true } },
} as const;

export async function listCounterSales(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = typeof query.status === "string" ? query.status : undefined;
  const storeId = typeof query.storeId === "string" ? query.storeId : undefined;

  const where = { ...(status ? { status } : {}), ...(storeId ? { storeId } : {}) };

  const [items, total] = await Promise.all([
    prisma.counterSale.findMany({ where, include, orderBy: { createdAt: "desc" }, skip: pageParams.skip, take: pageParams.take }),
    prisma.counterSale.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

// Venda de balcão é criada e completada em um único passo (paga na hora): valida
// estoque, decrementa, e já nasce como uma AccountReceivable RECEIVED.
export async function createCounterSale(input: CounterSaleInput) {
  if (input.items.length === 0) throw new CounterSaleError("Informe ao menos um item.", 400);

  const parts = await prisma.inventoryPart.findMany({
    where: { id: { in: input.items.map((i) => i.inventoryPartId) } },
  });
  for (const item of input.items) {
    const part = parts.find((p) => p.id === item.inventoryPartId);
    if (!part || !part.active) throw new CounterSaleError(`Peça ${item.inventoryPartId} não encontrada.`, 404);
    if (part.stockQty < item.quantity) throw new CounterSaleError(`Estoque insuficiente de "${part.name}".`, 409);
  }

  const totalAmount = input.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const code = await nextCounterSaleCode();
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    for (const item of input.items) {
      await tx.inventoryPart.update({ where: { id: item.inventoryPartId }, data: { stockQty: { decrement: item.quantity } } });
    }

    const receivable = await tx.accountReceivable.create({
      data: {
        description: `Venda de balcão ${code}`,
        category: "PDV",
        clientId: input.clientId,
        amount: totalAmount,
        dueDate: now,
        status: "RECEIVED",
        receivedAt: now,
        receivedAmount: totalAmount,
        paymentMethod: input.paymentMethod,
        bankAccountId: input.bankAccountId,
      },
    });

    const sale = await tx.counterSale.create({
      data: {
        code,
        clientId: input.clientId,
        customerName: input.customerName,
        paymentMethod: input.paymentMethod,
        bankAccountId: input.bankAccountId,
        storeId: input.storeId,
        accountReceivableId: receivable.id,
        totalAmount,
        items: { create: input.items },
      },
      include,
    });

    // Se o preço de venda ficou acima do custo da peça pra oficina, a diferença é
    // lucro — entra como entrada no financeiro (Resumo já soma todo FinancialEntry
    // INCOME; o fluxo de caixa ignora essa categoria pra não contar a mesma venda
    // duas vezes, já que a receita cheia já está na conta a receber "PDV" acima).
    for (const item of input.items) {
      const part = parts.find((p) => p.id === item.inventoryPartId)!;
      const profit = (item.unitPrice - part.unitCost) * item.quantity;
      if (profit > 0) {
        await tx.financialEntry.create({
          data: {
            type: "INCOME",
            category: "LUCRO_PDV",
            description: `Margem na venda de balcão ${code} — ${part.name}`,
            amount: profit,
            inventoryPartId: part.id,
            counterSaleId: sale.id,
            occurredAt: now,
          },
        });
      }
    }

    return sale;
  });
}

export async function cancelCounterSale(id: string) {
  const sale = await prisma.counterSale.findUnique({ where: { id }, include: { items: true } });
  if (!sale) throw new CounterSaleError("Venda não encontrada.", 404);
  if (sale.status === "CANCELLED") throw new CounterSaleError("Esta venda já foi cancelada.", 409);

  return prisma.$transaction(async (tx) => {
    for (const item of sale.items) {
      await tx.inventoryPart.update({ where: { id: item.inventoryPartId }, data: { stockQty: { increment: item.quantity } } });
    }
    if (sale.accountReceivableId) {
      await tx.accountReceivable.update({ where: { id: sale.accountReceivableId }, data: { status: "CANCELLED" } });
    }
    // Desfaz a margem de lucro lançada na criação da venda — senão o cancelamento
    // deixaria uma entrada fantasma no financeiro.
    await tx.financialEntry.deleteMany({ where: { counterSaleId: sale.id } });
    return tx.counterSale.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() }, include });
  });
}
