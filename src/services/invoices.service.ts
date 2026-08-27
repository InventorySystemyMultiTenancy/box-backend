import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";
import { NFeProvider } from "@/services/fiscal/nfe-provider";
import { MockNFeProvider } from "@/services/fiscal/mock-provider";
import { createAccountsPayable } from "@/services/accounts-payable.service";

export class InvoiceError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface InvoiceInput {
  type: "NFE" | "NFSE" | "NFCE";
  totalAmount: number;
  description: string;
  serviceOrderId?: string;
  clientId?: string;
  accountReceivableId?: string;
  // Preenchidos quando a nota já existe fisicamente (digitada à mão ou lida por IA a
  // partir de uma foto) — nesse caso a nota nasce ISSUED, não DRAFT.
  number?: string;
  series?: string;
  accessKey?: string;
  operationNature?: string;
  issuerName?: string;
  issuerDocument?: string;
  recipientName?: string;
  recipientDocument?: string;
  paymentMethod?: string;
  discountAmount?: number;
  taxAmount?: number;
  issueDate?: string;
  // Só usados quando paymentMethod é "boleto" — geram N contas a pagar em meses
  // consecutivos a partir de dueDate (ver services/accounts-payable.service.ts).
  installments?: number;
  dueDate?: string;
}

function isBoleto(paymentMethod?: string) {
  return Boolean(paymentMethod?.trim().toLowerCase().includes("boleto"));
}

// Ponto único de troca do gateway fiscal — plugar um provider real aqui quando a
// oficina tiver certificado digital e contrato com um gateway (eNotas, Focus NFe...).
const provider: NFeProvider = new MockNFeProvider();

export async function listInvoices(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = typeof query.status === "string" ? query.status : undefined;
  const type = typeof query.type === "string" ? query.type : undefined;

  const where = {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        client: true,
        serviceOrder: { select: { id: true, code: true } },
        payables: { orderBy: { dueDate: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.invoice.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

// Se `number` vier preenchido, a nota já existe fisicamente (digitada ou lida de uma
// foto) — nasce ISSUED. Caso contrário, nasce DRAFT para ser emitida depois via /issue.
// Quando a forma de pagamento é "boleto", também gera as parcelas como contas a
// pagar (uma por mês, a partir de dueDate) já ligadas a esta nota.
export async function createInvoiceDraft(input: InvoiceInput) {
  const boleto = isBoleto(input.paymentMethod);
  if (boleto && !input.dueDate) {
    throw new InvoiceError("Informe a data de vencimento do primeiro boleto.", 400);
  }

  const isExisting = Boolean(input.number);
  const invoice = await prisma.invoice.create({
    data: {
      type: input.type,
      status: isExisting ? "ISSUED" : "DRAFT",
      totalAmount: input.totalAmount,
      description: input.description,
      serviceOrderId: input.serviceOrderId,
      clientId: input.clientId,
      accountReceivableId: input.accountReceivableId,
      number: input.number,
      series: input.series,
      accessKey: input.accessKey,
      operationNature: input.operationNature,
      issuerName: input.issuerName,
      issuerDocument: input.issuerDocument,
      recipientName: input.recipientName,
      recipientDocument: input.recipientDocument,
      paymentMethod: input.paymentMethod,
      discountAmount: input.discountAmount,
      taxAmount: input.taxAmount,
      issueDate: isExisting ? new Date(input.issueDate ?? Date.now()) : undefined,
      provider: isExisting ? "MANUAL" : provider.name,
    },
  });

  if (boleto && input.dueDate) {
    await createAccountsPayable({
      description: input.description || `Nota fiscal ${input.number ?? invoice.id}`,
      category: "FORNECEDOR",
      payeeName: input.issuerName || input.description || "Fornecedor",
      amount: input.totalAmount,
      dueDate: input.dueDate,
      paymentMethod: input.paymentMethod,
      installments: input.installments,
      invoiceId: invoice.id,
    });
  }

  return prisma.invoice.findUnique({ where: { id: invoice.id }, include: { payables: { orderBy: { dueDate: "asc" } } } });
}

export async function issueInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { client: true } });
  if (!invoice) throw new InvoiceError("Nota fiscal não encontrada.", 404);
  if (invoice.status === "ISSUED") throw new InvoiceError("Esta nota já foi emitida.", 409);
  if (invoice.status === "CANCELLED") throw new InvoiceError("Esta nota foi cancelada.", 409);

  try {
    const result = await provider.issue({
      type: invoice.type as "NFE" | "NFSE" | "NFCE",
      totalAmount: invoice.totalAmount,
      clientName: invoice.client?.name,
      description: `Emissão referente à OS/cobrança ${invoice.id}`,
    });

    return prisma.invoice.update({
      where: { id },
      data: {
        status: "ISSUED",
        number: result.number,
        series: result.series,
        providerRef: result.providerRef,
        xmlUrl: result.xmlUrl,
        pdfUrl: result.pdfUrl,
        issueDate: new Date(),
        errorMessage: null,
      },
    });
  } catch (err) {
    await prisma.invoice.update({
      where: { id },
      data: { status: "ERROR", errorMessage: err instanceof Error ? err.message : "Falha ao emitir." },
    });
    throw new InvoiceError("Falha ao emitir a nota fiscal.", 502);
  }
}

export async function cancelInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) throw new InvoiceError("Nota fiscal não encontrada.", 404);
  if (invoice.status !== "ISSUED") throw new InvoiceError("Só é possível cancelar uma nota emitida.", 409);

  if (invoice.providerRef) await provider.cancel(invoice.providerRef);

  return prisma.invoice.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}
