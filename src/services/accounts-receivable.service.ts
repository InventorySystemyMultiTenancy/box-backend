import { randomUUID } from "crypto";
import { prisma, toNumber } from "@/lib/prisma";
import { pageAcrossSegments, parsePageParams, paginated } from "@/lib/pagination";
import { dueDateFromInput, parseSettlementDate, SettlementDateError, splitInstallments, summarizeSettlementGroups } from "@/services/finance-rules";
import { endOfPeriod } from "@/services/cash-flow.service";
import { createOrderReceivables } from "@/services/service-order-billing.service";

/**
 * Conta a receber vencida: pendente sem prazo, ou com o prazo já passado. É a regra usada
 * para virar OVERDUE (aqui e no agendador) — sem prazo, já aparece como vencida.
 */
export function overdueReceivableWhere(now = new Date()) {
  return { status: "PENDING", OR: [{ dueDate: null }, { dueDate: { lt: now } }] };
}

export class ReceivableError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface AccountReceivableInput {
  description: string;
  category: string;
  clientId?: string;
  serviceOrderId?: string;
  amount: number;
  dueDate: string;
  paymentMethod?: string;
  bankAccountId?: string;
  notes?: string;
  installments?: number;
}

export interface ReceiveInput {
  receivedAt?: string;
  receivedAmount?: number;
  bankAccountId?: string;
  paymentMethod?: string;
}

export interface UpdateReceivableInput {
  description?: string;
  category?: string;
  clientId?: string;
  amount?: number;
  dueDate?: string;
  paymentMethod?: string;
  bankAccountId?: string;
  notes?: string;
  receivedAt?: string;
  receivedAmount?: number;
}

export async function createAccountsReceivable(input: AccountReceivableInput) {
  const parts = splitInstallments(input.amount, input.installments ?? 1, dueDateFromInput(input.dueDate));
  const installments = parts.length;
  const groupId = installments > 1 ? randomUUID() : undefined;

  const rows = parts.map((part, i) => {
    return {
      description: input.description,
      category: input.category,
      clientId: input.clientId,
      serviceOrderId: input.serviceOrderId,
      amount: part.amount,
      dueDate: part.dueDate,
      paymentMethod: input.paymentMethod,
      bankAccountId: input.bankAccountId,
      notes: input.notes,
      installmentNumber: installments > 1 ? i + 1 : undefined,
      installmentTotal: installments > 1 ? installments : undefined,
      groupId,
    };
  });

  // Devolve exatamente as linhas criadas (buscar por descrição/data podia trazer outra conta igual).
  return prisma.accountReceivable.createManyAndReturn({ data: rows });
}

// Filtros da aba Contas a receber, SEM o de status — reaproveitado pela lista e pelos totais.
function receivableFilters(query: Record<string, unknown>) {
  const category = typeof query.category === "string" && query.category ? query.category : undefined;
  const clientId = typeof query.clientId === "string" && query.clientId ? query.clientId : undefined;
  const from = typeof query.from === "string" && query.from ? new Date(query.from) : undefined;
  // "até" só com data inclui o dia inteiro.
  const to = typeof query.to === "string" && query.to ? endOfPeriod(query.to) : undefined;
  // Busca livre: descrição (placa nas contas de projeto), código da OS, placa ou cliente.
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined;
  const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
  return {
    ...(contains
      ? {
          OR: [
            { description: contains },
            { serviceOrder: { code: contains } },
            { serviceOrder: { vehicle: { plate: contains } } },
            { client: { name: contains } },
          ],
        }
      : {}),
    ...(category ? { category } : {}),
    ...(clientId ? { clientId } : {}),
    ...(from || to ? { dueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
}

/**
 * Totais do topo da aba Contas a receber (mesmos filtros da lista, sem o de status): em
 * aberto (pendentes + vencidas, vencidas à parte) e já recebido (valor efetivamente recebido).
 */
export async function summarizeAccountsReceivable(query: Record<string, unknown>) {
  const where = receivableFilters(query);
  await markOverdueReceivables();
  const [groups, receivedWithAmount, receivedWithoutAmount] = await Promise.all([
    prisma.accountReceivable.groupBy({
      by: ["status"],
      where: { ...where, status: { in: ["PENDING", "OVERDUE", "RECEIVED"] } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.accountReceivable.aggregate({ where: { ...where, status: "RECEIVED", receivedAmount: { not: null } }, _sum: { receivedAmount: true } }),
    prisma.accountReceivable.aggregate({ where: { ...where, status: "RECEIVED", receivedAmount: null }, _sum: { amount: true } }),
  ]);
  return summarizeSettlementGroups(
    groups.map((g) => ({ status: g.status, amount: toNumber(g._sum.amount) ?? 0, count: g._count._all })),
    (toNumber(receivedWithAmount._sum.receivedAmount) ?? 0) + (toNumber(receivedWithoutAmount._sum.amount) ?? 0),
    "RECEIVED"
  );
}

export async function listAccountsReceivable(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = typeof query.status === "string" && query.status ? query.status : undefined;

  await markOverdueReceivables();

  const where = {
    ...receivableFilters(query),
    ...(status ? { status } : {}),
  };

  const include = { bankAccount: true, client: true, serviceOrder: { select: { id: true, code: true } } };

  // Sem filtro de status: vencidas e as mais próximas do vencimento no topo,
  // depois recebidas/canceladas (as de vencimento mais recente primeiro).
  if (!status) {
    const open = { ...where, status: { in: ["PENDING", "OVERDUE"] } };
    const closed = { ...where, status: { notIn: ["PENDING", "OVERDUE"] } };
    const { items, total } = await pageAcrossSegments(
      pageParams,
      {
        count: () => prisma.accountReceivable.count({ where: open }),
        // Sem prazo primeiro (já vencidas), depois o prazo mais antigo.
        find: (skip, take) => prisma.accountReceivable.findMany({ where: open, include, orderBy: { dueDate: { sort: "asc", nulls: "first" } }, skip, take }),
      },
      {
        count: () => prisma.accountReceivable.count({ where: closed }),
        find: (skip, take) => prisma.accountReceivable.findMany({ where: closed, include, orderBy: { dueDate: { sort: "desc", nulls: "last" } }, skip, take }),
      }
    );
    return paginated(items, total, pageParams);
  }

  const [items, total] = await Promise.all([
    prisma.accountReceivable.findMany({
      where,
      include,
      orderBy: { dueDate: "asc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.accountReceivable.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function receiveAccountReceivable(id: string, input: ReceiveInput) {
  const receivable = await prisma.accountReceivable.findUnique({ where: { id } });
  if (!receivable) throw new ReceivableError("Conta a receber não encontrada.", 404);
  if (receivable.status === "RECEIVED") throw new ReceivableError("Esta conta já foi recebida.", 409);
  if (receivable.status === "CANCELLED") throw new ReceivableError("Esta conta foi cancelada.", 409);

  // Data em que foi recebido: a escolhida no formulário ou, se não informada, agora.
  let receivedAt: Date;
  try {
    receivedAt = parseSettlementDate(input.receivedAt);
  } catch (err) {
    if (err instanceof SettlementDateError) throw new ReceivableError(err.message, 400);
    throw err;
  }

  return prisma.accountReceivable.update({
    where: { id },
    data: {
      status: "RECEIVED",
      receivedAt,
      receivedAmount: input.receivedAmount ?? receivable.amount,
      bankAccountId: input.bankAccountId ?? receivable.bankAccountId,
      paymentMethod: input.paymentMethod ?? receivable.paymentMethod,
    },
  });
}

// Edição livre de qualquer campo pelo usuário, inclusive de uma conta já recebida.
export async function updateAccountReceivable(id: string, input: UpdateReceivableInput) {
  const existing = await prisma.accountReceivable.findUnique({ where: { id } });
  if (!existing) throw new ReceivableError("Conta a receber não encontrada.", 404);

  return prisma.accountReceivable.update({
    where: { id },
    data: {
      description: input.description,
      category: input.category,
      clientId: input.clientId,
      amount: input.amount,
      dueDate: input.dueDate ? dueDateFromInput(input.dueDate) : undefined,
      paymentMethod: input.paymentMethod,
      bankAccountId: input.bankAccountId,
      notes: input.notes,
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : undefined,
      receivedAmount: input.receivedAmount,
    },
  });
}

export async function cancelAccountReceivable(id: string) {
  const receivable = await prisma.accountReceivable.findUnique({ where: { id } });
  if (!receivable) throw new ReceivableError("Conta a receber não encontrada.", 404);
  return prisma.accountReceivable.update({ where: { id }, data: { status: "CANCELLED" } });
}

// Gera a cobrança de uma OS manualmente (ex.: OS antiga, ou cobrança cancelada e refeita) —
// mesma regra da entrega (PATCH /service-orders/:id/finalize, que já gera sozinha): recusa
// se a OS já tem cobrança, pra receita nunca contar duas vezes.
export async function createReceivableFromServiceOrder(serviceOrderId: string, dueDate: string) {
  const order = await prisma.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: { vehicle: { include: { owner: { include: { client: { select: { id: true } } } } } } },
  });
  if (!order) throw new ReceivableError("Ordem de serviço não encontrada.", 404);

  const [receivable] = await prisma.$transaction((tx) =>
    createOrderReceivables(tx, order, order.deliveryExtraValue ?? 0, { firstDueDate: dueDate })
  );
  if (!receivable) throw new ReceivableError("Nenhum serviço concluído com valor para gerar cobrança.", 400);
  return receivable;
}

async function markOverdueReceivables() {
  await prisma.accountReceivable.updateMany({ where: overdueReceivableWhere(), data: { status: "OVERDUE" } });
}

/**
 * Coluna "Prazo" da lista: define (ou limpa) o vencimento de uma conta em aberto. Prazo
 * futuro devolve a conta vencida para pendente; sem prazo ou com prazo passado, vencida.
 */
export async function setAccountReceivableDueDate(id: string, dueDate: string | null) {
  const existing = await prisma.accountReceivable.findUnique({ where: { id } });
  if (!existing) throw new ReceivableError("Conta a receber não encontrada.", 404);
  if (existing.status !== "PENDING" && existing.status !== "OVERDUE") {
    throw new ReceivableError("Só dá para mudar o prazo de uma conta em aberto.", 409);
  }
  const due = dueDate ? dueDateFromInput(dueDate) : null;
  const overdue = !due || due.getTime() < Date.now();
  return prisma.accountReceivable.update({ where: { id }, data: { dueDate: due, status: overdue ? "OVERDUE" : "PENDING" } });
}
