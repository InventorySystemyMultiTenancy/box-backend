import { prisma } from "@/lib/prisma";

export class BankAccountError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface BankAccountInput {
  name: string;
  bank?: string;
  agency?: string;
  accountNumber?: string;
  initialBalance?: number;
}

export async function listBankAccounts() {
  const accounts = await prisma.bankAccount.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
  });
  return Promise.all(accounts.map(withBalance));
}

export async function getBankAccountDetail(id: string) {
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new BankAccountError("Conta bancária não encontrada.", 404);
  return withBalance(account);
}

export async function createBankAccount(input: BankAccountInput) {
  const account = await prisma.bankAccount.create({ data: input });
  return withBalance(account);
}

export async function updateBankAccount(id: string, input: Partial<BankAccountInput>) {
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new BankAccountError("Conta bancária não encontrada.", 404);
  const updated = await prisma.bankAccount.update({ where: { id }, data: input });
  return withBalance(updated);
}

export async function archiveBankAccount(id: string) {
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new BankAccountError("Conta bancária não encontrada.", 404);
  await prisma.bankAccount.update({ where: { id }, data: { active: false } });
}

// Saldo atual = saldo inicial + total recebido - total pago, considerando só
// lançamentos já baixados (paidAt/receivedAt preenchidos) nesta conta.
async function withBalance<T extends { id: string; initialBalance: number }>(account: T) {
  const [received, paid] = await Promise.all([
    prisma.accountReceivable.aggregate({
      where: { bankAccountId: account.id, status: "RECEIVED" },
      _sum: { receivedAmount: true },
    }),
    prisma.accountPayable.aggregate({
      where: { bankAccountId: account.id, status: "PAID" },
      _sum: { paidAmount: true },
    }),
  ]);

  const currentBalance =
    account.initialBalance + (received._sum.receivedAmount ?? 0) - (paid._sum.paidAmount ?? 0);

  return { ...account, currentBalance };
}
