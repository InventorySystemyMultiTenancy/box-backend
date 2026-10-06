// Regras puras (sem banco) do financeiro — compartilhadas entre rotas e
// serviços, e cobertas por testes em finance-rules.test.ts.

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
