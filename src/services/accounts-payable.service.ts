import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";

export class PayableError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface AccountPayableInput {
  description: string;
  category: string;
  payeeName: string;
  amount: number;
  dueDate: string;
  paymentMethod?: string;
  bankAccountId?: string;
  notes?: string;
  installments?: number;
}

export interface PayInput {
  paidAt?: string;
  paidAmount?: number;
  bankAccountId?: string;
  paymentMethod?: string;
}

// Uma compra parcelada vira N registros com o mesmo groupId, vencendo em meses
// consecutivos a partir da dueDate informada — cada parcela é baixada individualmente.
export async function createAccountsPayable(input: AccountPayableInput) {
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
      payeeName: input.payeeName,
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

  await prisma.accountPayable.createMany({ data: rows });
  return prisma.accountPayable.findMany({
    where: groupId ? { groupId } : { description: input.description, payeeName: input.payeeName },
    orderBy: { dueDate: "asc" },
    take: installments,
  });
}

export async function listAccountsPayable(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = typeof query.status === "string" ? query.status : undefined;
  const category = typeof query.category === "string" ? query.category : undefined;
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;

  await markOverduePayables();

  const where = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(from || to ? { dueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.accountPayable.findMany({
      where,
      include: { bankAccount: true },
      orderBy: { dueDate: "asc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.accountPayable.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function payAccountPayable(id: string, input: PayInput) {
  const payable = await prisma.accountPayable.findUnique({ where: { id } });
  if (!payable) throw new PayableError("Conta a pagar não encontrada.", 404);
  if (payable.status === "PAID") throw new PayableError("Esta conta já está paga.", 409);

  return prisma.accountPayable.update({
    where: { id },
    data: {
      status: "PAID",
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      paidAmount: input.paidAmount ?? payable.amount,
      bankAccountId: input.bankAccountId ?? payable.bankAccountId,
      paymentMethod: input.paymentMethod ?? payable.paymentMethod,
    },
  });
}

export async function cancelAccountPayable(id: string) {
  const payable = await prisma.accountPayable.findUnique({ where: { id } });
  if (!payable) throw new PayableError("Conta a pagar não encontrada.", 404);
  return prisma.accountPayable.update({ where: { id }, data: { status: "CANCELLED" } });
}

async function markOverduePayables() {
  await prisma.accountPayable.updateMany({
    where: { status: "PENDING", dueDate: { lt: new Date() } },
    data: { status: "OVERDUE" },
  });
}
