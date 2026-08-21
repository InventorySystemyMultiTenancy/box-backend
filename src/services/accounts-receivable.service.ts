import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";

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

export async function createAccountsReceivable(input: AccountReceivableInput) {
  const installments = Math.max(1, Math.floor(input.installments ?? 1));
  const groupId = installments > 1 ? randomUUID() : undefined;
  const baseDueDate = new Date(input.dueDate);
  const baseAmount = Math.floor((input.amount / installments) * 100) / 100;
  const remainder = Math.round((input.amount - baseAmount * installments) * 100) / 100;

  const rows = Array.from({ length: installments }, (_, i) => {
    const dueDate = new Date(baseDueDate);
    dueDate.setMonth(dueDate.getMonth() + i);
    return {
      description: input.description,
      category: input.category,
      clientId: input.clientId,
      serviceOrderId: input.serviceOrderId,
      amount: i === installments - 1 ? baseAmount + remainder : baseAmount,
      dueDate,
      paymentMethod: input.paymentMethod,
      bankAccountId: input.bankAccountId,
      notes: input.notes,
      installmentNumber: installments > 1 ? i + 1 : undefined,
      installmentTotal: installments > 1 ? installments : undefined,
      groupId,
    };
  });

  await prisma.accountReceivable.createMany({ data: rows });
  return prisma.accountReceivable.findMany({
    where: groupId ? { groupId } : { description: input.description, dueDate: rows[0].dueDate },
    orderBy: { dueDate: "asc" },
    take: installments,
  });
}

export async function listAccountsReceivable(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = typeof query.status === "string" ? query.status : undefined;
  const category = typeof query.category === "string" ? query.category : undefined;
  const clientId = typeof query.clientId === "string" ? query.clientId : undefined;
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;

  await markOverdueReceivables();

  const where = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(clientId ? { clientId } : {}),
    ...(from || to ? { dueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.accountReceivable.findMany({
      where,
      include: { bankAccount: true, client: true, serviceOrder: { select: { id: true, code: true } } },
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

  return prisma.accountReceivable.update({
    where: { id },
    data: {
      status: "RECEIVED",
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
      receivedAmount: input.receivedAmount ?? receivable.amount,
      bankAccountId: input.bankAccountId ?? receivable.bankAccountId,
      paymentMethod: input.paymentMethod ?? receivable.paymentMethod,
    },
  });
}

export async function cancelAccountReceivable(id: string) {
  const receivable = await prisma.accountReceivable.findUnique({ where: { id } });
  if (!receivable) throw new ReceivableError("Conta a receber não encontrada.", 404);
  return prisma.accountReceivable.update({ where: { id }, data: { status: "CANCELLED" } });
}

// Gera uma conta a receber a partir do total já aprovado numa OS (soma dos Approval
// com status APPROVED) — atalho para fechar a cobrança do cliente ao concluir o serviço.
export async function createReceivableFromServiceOrder(serviceOrderId: string, dueDate: string) {
  const order = await prisma.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: {
      approvals: { where: { status: "APPROVED" } },
      vehicle: { include: { owner: { include: { client: true } } } },
    },
  });
  if (!order) throw new ReceivableError("Ordem de serviço não encontrada.", 404);

  // estimatedValue é mantido em sincronia com laborValue + partsValue pelas rotas
  // de precificação (parts.routes.ts) — é o total já cobrável de cada problema aprovado.
  const total = order.approvals.reduce((sum, a) => sum + (a.estimatedValue ?? 0), 0);
  if (total <= 0) throw new ReceivableError("Nenhum valor aprovado para gerar cobrança.", 400);

  const receivable = await prisma.accountReceivable.create({
    data: {
      description: `Serviços aprovados — OS ${order.code}`,
      category: "SERVIÇO",
      serviceOrderId: order.id,
      clientId: order.vehicle.owner.client?.id,
      amount: total,
      dueDate: new Date(dueDate),
    },
  });
  return receivable;
}

async function markOverdueReceivables() {
  await prisma.accountReceivable.updateMany({
    where: { status: "PENDING", dueDate: { lt: new Date() } },
    data: { status: "OVERDUE" },
  });
}
