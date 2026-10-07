// Regras puras (sem banco) do financeiro — compartilhadas entre rotas e
// serviços, e cobertas por testes em finance-rules.test.ts.

/**
 * Data em que a conta foi efetivamente paga/recebida (formulários "Pagar"/"Receber"):
 * sem data → agora; só a data ("2026-10-05") → meio-dia desse dia (meia-noite UTC
 * apareceria como o dia anterior no horário de Brasília). Recusa data inválida ou futura.
 */
export function parseSettlementDate(value: string | undefined, now = new Date()): Date {
  if (!value) return now;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new SettlementDateError("Data de pagamento inválida.");
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  if (date > endOfToday) throw new SettlementDateError("A data do pagamento não pode ser no futuro.");
  return date;
}

export class SettlementDateError extends Error {}

export interface SettlementSummary {
  open: { total: number; count: number };
  overdue: { total: number; count: number };
  settled: { total: number; count: number };
}

/**
 * Totais do topo de Contas a pagar/receber a partir dos grupos por status: em aberto =
 * pendentes + vencidas (vencidas também à parte); quitadas = PAID/RECEIVED, com o valor
 * efetivamente pago/recebido (`settledAmount`, que pode diferir do valor da conta).
 */
export function summarizeSettlementGroups(
  groups: { status: string; amount: number; count: number }[],
  settledAmount: number,
  settledStatus: "PAID" | "RECEIVED"
): SettlementSummary {
  const pick = (statuses: string[]) => {
    const rows = groups.filter((g) => statuses.includes(g.status));
    return { total: roundMoney(rows.reduce((s, g) => s + g.amount, 0)), count: rows.reduce((s, g) => s + g.count, 0) };
  };
  const settled = pick([settledStatus]);
  return {
    open: pick(["PENDING", "OVERDUE"]),
    overdue: pick(["OVERDUE"]),
    settled: { total: roundMoney(settledAmount), count: settled.count },
  };
}

/** Arredonda pra centavos sem o erro clássico de float (ex.: 1.005 -> 1.01). */
export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface Installment {
  number: number;
  amount: number;
  dueDate: Date;
}

/** Divide um valor em parcelas mensais exatas em centavos — a diferença de arredondamento vai na última. */
export function splitInstallments(amount: number, count: number, firstDueDate: Date): Installment[] {
  const total = Math.max(1, Math.floor(count));
  const totalCents = Math.round(amount * 100);
  const baseCents = Math.floor(totalCents / total);
  return Array.from({ length: total }, (_, i) => {
    const dueDate = new Date(firstDueDate);
    dueDate.setMonth(dueDate.getMonth() + i);
    const cents = i === total - 1 ? totalCents - baseCents * (total - 1) : baseCents;
    return { number: i + 1, amount: cents / 100, dueDate };
  });
}

interface BillableApproval {
  status: string;
  estimatedValue: number | null;
  part: { status: string } | null;
}

/**
 * Total cobrável de uma OS na entrega: trabalho de fato concluído (problema com a peça em
 * DONE), aprovado ou não pelo cliente, exceto o que ele reprovou explicitamente. Sem nenhum
 * problema precificado, cai no valor inicial estimado. O valor extra da entrega soma por fora.
 */
export function orderBillingTotal(approvals: BillableApproval[], estimatedMin: number | null, extraValue = 0) {
  const done = approvals
    .filter((a) => a.status !== "REJECTED" && a.part?.status === "DONE")
    .reduce((sum, a) => sum + (a.estimatedValue ?? 0), 0);
  return roundMoney((done || estimatedMin || 0) + (extraValue || 0));
}

// Categorias de FinancialEntry que a entrega da OS gerava antes de passar a criar conta a
// receber (ver PATCH /service-orders/:id/finalize). Continuam no banco para OS antigas.
export const LEGACY_ORDER_INCOME_CATEGORIES = new Set(["PROJETO", "ENTREGA_EXTRA"]);

interface IncomeEntryLike {
  type: string;
  category: string;
  serviceOrderId: string | null;
}

/**
 * Evita contar a mesma OS duas vezes: um lançamento antigo de receita da entrega
 * (PROJETO/ENTREGA_EXTRA) deixa de contar quando a OS já tem conta a receber — a receita
 * passa a vir só da conta a receber, no momento em que ela é efetivamente recebida.
 */
export function isDuplicatedOrderIncome(entry: IncomeEntryLike, ordersWithReceivables: Set<string>) {
  return (
    entry.type === "INCOME" &&
    LEGACY_ORDER_INCOME_CATEGORIES.has(entry.category) &&
    entry.serviceOrderId !== null &&
    ordersWithReceivables.has(entry.serviceOrderId)
  );
}
