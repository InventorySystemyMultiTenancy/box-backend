import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";
import { NFeProvider } from "@/services/fiscal/nfe-provider";
import { MockNFeProvider } from "@/services/fiscal/mock-provider";

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
      include: { client: true, serviceOrder: { select: { id: true, code: true } } },
      orderBy: { createdAt: "desc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.invoice.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function createInvoiceDraft(input: InvoiceInput) {
  return prisma.invoice.create({
    data: {
      type: input.type,
      status: "DRAFT",
      totalAmount: input.totalAmount,
      serviceOrderId: input.serviceOrderId,
      clientId: input.clientId,
      accountReceivableId: input.accountReceivableId,
      provider: provider.name,
    },
  });
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
