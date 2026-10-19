import { randomUUID } from "crypto";
import { prisma, AppTx } from "@/lib/prisma";
import { HttpError } from "@/lib/http-error";
import { dueDateFromInput, LEGACY_ORDER_INCOME_CATEGORIES, isDuplicatedOrderIncome, orderBillingTotal, splitInstallments } from "@/services/finance-rules";

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
  bankAccountId?: string;
}

/** Dados da OS que a cobrança usa: valor, cliente e o veículo (placa vai na descrição). */
export interface BillableOrder {
  id: string;
  code: string;
  estimatedMin: number | null;
  vehicle: { plate: string | null; brand: string; model: string; owner: { client: { id: string } | null } };
}

/** "Serviços — ABC1D23" (placa); sem placa, marca/modelo. A OS continua ligada (busca por OS). */
export function orderReceivableDescription(vehicle: BillableOrder["vehicle"]) {
  return `Serviços — ${vehicle.plate?.trim() || `${vehicle.brand} ${vehicle.model}`}`;
}

/** Include do Prisma com o que BillableOrder precisa. */
export const BILLABLE_ORDER_INCLUDE = {
  vehicle: { include: { owner: { include: { client: { select: { id: true } } } } } },
} as const;

/**
 * Gera a cobrança de uma OS como conta(s) a receber — sempre PENDENTE: o recebimento (com a
 * data e o valor real, que pode ter desconto) é dado em Financeiro > Contas a receber. A
 * receita só entra no Resumo/Fluxo de caixa/DRE quando cada parcela é de fato recebida, e
 * nunca duas vezes para a mesma OS.
 */
export async function createOrderReceivables(tx: AppTx, order: BillableOrder, extraValue: number, payment: OrderPaymentInput) {
  if (await orderAlreadyBilled(tx, order.id)) {
    throw new HttpError(409, "Esta OS já tem cobrança gerada — confira em Financeiro > Contas a receber.");
  }

  const approvals = await tx.approval.findMany({
    where: { serviceOrderId: order.id },
    select: { status: true, estimatedValue: true, part: { select: { status: true } } },
  });
  const total = orderBillingTotal(approvals, order.estimatedMin, extraValue);
  if (total <= 0) return [];

  const installments = splitInstallments(total, payment.installments ?? 1, payment.firstDueDate ? dueDateFromInput(payment.firstDueDate) : new Date());
  // À vista sem prazo escolhido: fica sem prazo (aparece vencida até alguém pôr a data na
  // coluna Prazo do Financeiro). Parcelado sem data: parcelas a partir de hoje.
  const withoutDueDate = !payment.firstDueDate && installments.length === 1;
  const groupId = installments.length > 1 ? randomUUID() : undefined;

  const created = [];
  for (const inst of installments) {
    created.push(
      await tx.accountReceivable.create({
        data: {
          description: orderReceivableDescription(order.vehicle),
          category: ORDER_RECEIVABLE_CATEGORY,
          serviceOrderId: order.id,
          clientId: order.vehicle.owner.client?.id,
          amount: inst.amount,
          dueDate: withoutDueDate ? null : inst.dueDate,
          paymentMethod: payment.paymentMethod,
          bankAccountId: payment.bankAccountId,
          installmentNumber: installments.length > 1 ? inst.number : undefined,
          installmentTotal: installments.length > 1 ? installments.length : undefined,
          groupId,
        },
      })
    );
  }
  return created;
}

/**
 * Projeto chegou em "Finalizado": lança a cobrança já (pendente, à vista, sem prazo — o prazo
 * é posto depois no Financeiro), sem esperar a entrega. Se já existe cobrança, não faz nada.
 */
export async function billFinishedOrder(tx: AppTx, serviceOrderId: string) {
  if (await orderAlreadyBilled(tx, serviceOrderId)) return [];
  const order = await tx.serviceOrder.findUniqueOrThrow({ where: { id: serviceOrderId }, include: BILLABLE_ORDER_INCLUDE });
  return createOrderReceivables(tx, order, 0, {});
}

/**
 * Cobrança na entrega (finalize). Sem cobrança ainda: cria com as condições escolhidas. Já
 * cobrada ao chegar em "Finalizado" e nada recebido/faturado em nota: refaz com a forma de
 * pagamento, parcelas, vencimento e valor extra da entrega. Se algo já foi recebido (ou há
 * nota ligada), mantém o que existe e só lança o valor extra como uma conta a mais.
 */
export async function billOrderOnDelivery(tx: AppTx, order: BillableOrder, extraValue: number, payment: OrderPaymentInput) {
  const existing = await tx.accountReceivable.findMany({
    where: { serviceOrderId: order.id, status: { not: "CANCELLED" } },
    select: { id: true, status: true, _count: { select: { invoices: true } } },
  });
  const legacyEntries = await tx.financialEntry.count({
    where: { serviceOrderId: order.id, type: "INCOME", category: { in: [...LEGACY_ORDER_INCOME_CATEGORIES] } },
  });
  if (legacyEntries > 0) return [];

  if (existing.length === 0) return createOrderReceivables(tx, order, extraValue, payment);

  const untouched = existing.every((r) => (r.status === "PENDING" || r.status === "OVERDUE") && r._count.invoices === 0);
  if (untouched) {
    await tx.accountReceivable.deleteMany({ where: { id: { in: existing.map((r) => r.id) } } });
    return createOrderReceivables(tx, order, extraValue, payment);
  }

  if (extraValue <= 0) return [];
  return [
    await tx.accountReceivable.create({
      data: {
        description: `${orderReceivableDescription(order.vehicle)} (valor extra na entrega)`,
        category: ORDER_RECEIVABLE_CATEGORY,
        serviceOrderId: order.id,
        clientId: order.vehicle.owner.client?.id,
        amount: extraValue,
        dueDate: payment.firstDueDate ? dueDateFromInput(payment.firstDueDate) : null,
        paymentMethod: payment.paymentMethod,
        bankAccountId: payment.bankAccountId,
      },
    }),
  ];
}
