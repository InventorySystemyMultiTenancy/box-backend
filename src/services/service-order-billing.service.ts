import { randomUUID } from "crypto";
import { prisma, AppTx } from "@/lib/prisma";
import { HttpError } from "@/lib/http-error";
import { LEGACY_ORDER_INCOME_CATEGORIES, isDuplicatedOrderIncome, orderBillingTotal, splitInstallments } from "@/services/finance-rules";

export const ORDER_RECEIVABLE_CATEGORY = "SERVIÇO";

type BillingDb = Pick<AppTx, "accountReceivable" | "financialEntry">;

/** OS já cobrada: tem conta a receber ativa ou o lançamento antigo de receita da entrega. */
export async function orderAlreadyBilled(db: BillingDb, serviceOrderId: string) {
  const [receivables, legacyEntries] = await Promise.all([
    db.accountReceivable.count({ where: { serviceOrderId, status: { not: "CANCELLED" } } }),
    db.financialEntry.count({ where: { serviceOrderId, type: "INCOME", category: { in: [...LEGACY_ORDER_INCOME_CATEGORIES] } } }),
  ]);
  return receivables > 0 || legacyEntries > 0;
}

/** IDs (dentre os informados, ou todos) de OS que já têm conta a receber ativa. */
export async function ordersWithReceivables(serviceOrderIds?: string[]) {
  const rows = await prisma.accountReceivable.findMany({
    where: {
      serviceOrderId: serviceOrderIds ? { in: serviceOrderIds } : { not: null },
      status: { not: "CANCELLED" },
    },
    select: { serviceOrderId: true },
    distinct: ["serviceOrderId"],
  });
  return new Set(rows.map((r) => r.serviceOrderId!));
}

/**
 * Remove de uma lista de FinancialEntry os lançamentos antigos de receita da entrega cuja
 * OS também tem conta a receber — a receita dessa OS passa a vir só da conta a receber.
 */
export async function dropDuplicatedOrderIncome<T extends { type: string; category: string; serviceOrderId: string | null }>(entries: T[]) {
  const candidateIds = [
    ...new Set(
      entries
        .filter((e) => e.type === "INCOME" && LEGACY_ORDER_INCOME_CATEGORIES.has(e.category) && e.serviceOrderId)
        .map((e) => e.serviceOrderId!)
    ),
  ];
  if (candidateIds.length === 0) return entries;
  const billed = await ordersWithReceivables(candidateIds);
  return entries.filter((e) => !isDuplicatedOrderIncome(e, billed));
}

export interface OrderPaymentInput {
  paymentMethod?: string;
  installments?: number;
  firstDueDate?: string;
  /** Cliente pagou na retirada — a 1ª parcela (ou o valor todo, se à vista) já nasce recebida. */
  receivedNow?: boolean;
  bankAccountId?: string;
}

/**
 * Gera a cobrança de uma OS como conta(s) a receber — a receita só entra no Resumo/Fluxo de
 * caixa/DRE quando cada parcela é de fato recebida, e nunca duas vezes para a mesma OS.
 */
export async function createOrderReceivables(
  tx: AppTx,
  order: { id: string; code: string; estimatedMin: number | null; vehicle: { owner: { client: { id: string } | null } } },
  extraValue: number,
  payment: OrderPaymentInput
) {
  if (await orderAlreadyBilled(tx, order.id)) {
    throw new HttpError(409, "Esta OS já tem cobrança gerada — confira em Financeiro > Contas a receber.");
  }

  const approvals = await tx.approval.findMany({
    where: { serviceOrderId: order.id },
    select: { status: true, estimatedValue: true, part: { select: { status: true } } },
  });
  const total = orderBillingTotal(approvals, order.estimatedMin, extraValue);
  if (total <= 0) return [];

  const now = new Date();
  const installments = splitInstallments(total, payment.installments ?? 1, payment.firstDueDate ? new Date(payment.firstDueDate) : now);
  const groupId = installments.length > 1 ? randomUUID() : undefined;

  const created = [];
  for (const inst of installments) {
    const received = payment.receivedNow && inst.number === 1;
    created.push(
      await tx.accountReceivable.create({
        data: {
          description: `Serviços — OS ${order.code}`,
          category: ORDER_RECEIVABLE_CATEGORY,
          serviceOrderId: order.id,
          clientId: order.vehicle.owner.client?.id,
          amount: inst.amount,
          dueDate: received ? now : inst.dueDate,
          paymentMethod: payment.paymentMethod,
          bankAccountId: payment.bankAccountId,
          installmentNumber: installments.length > 1 ? inst.number : undefined,
          installmentTotal: installments.length > 1 ? installments.length : undefined,
          groupId,
          ...(received ? { status: "RECEIVED", receivedAt: now, receivedAmount: inst.amount } : {}),
        },
      })
    );
  }
  return created;
}
