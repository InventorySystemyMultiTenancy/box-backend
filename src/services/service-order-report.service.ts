import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { prisma } from "@/lib/prisma";
import { STATUS_LABELS } from "@/lib/constants";
import { persistLocalFile, UPLOADS_DIR } from "@/middleware/upload";

// PDF de finalização do projeto — mesmo conteúdo do "Baixar PDF do projeto" da tela
// (OrderDetail.generateServicePdf), só que gerado no servidor como arquivo de verdade: fica
// salvo como mídia da OS e tem link público, que vai na mensagem de WhatsApp da entrega.

const PART_STATUS_LABELS: Record<string, string> = {
  NOT_INSPECTED: "Não inspecionado",
  IN_PROGRESS: "Em andamento",
  WARNING: "Aguardando aprovação",
  CRITICAL: "Problema encontrado",
  DONE: "Concluído",
};

const LOGO_PATH = path.resolve(process.cwd(), "assets/reblind-logo.png");
const MARGIN = 40;

function currency(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

type Column = { header: string; width: number };

/** Tabela simples com quebra de página — pdfkit não tem tabela nativa. */
function drawTable(doc: PDFKit.PDFDocument, columns: Column[], rows: string[][], emptyText: string) {
  const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const padding = 5;
  const bottom = doc.page.height - MARGIN;

  const rowHeight = (cells: string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    return Math.max(...cells.map((cell, i) => doc.heightOfString(cell, { width: columns[i].width - padding * 2 }))) + padding * 2;
  };

  const drawRow = (cells: string[], bold: boolean) => {
    const height = rowHeight(cells, bold);
    if (doc.y + height > bottom) doc.addPage();
    const top = doc.y;
    let x = MARGIN;
    if (bold) doc.rect(MARGIN, top, totalWidth, height).fill("#f4f4f4");
    doc.fillColor("#111").font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    cells.forEach((cell, i) => {
      doc.rect(x, top, columns[i].width, height).strokeColor("#dddddd").stroke();
      doc.fillColor("#111").text(cell, x + padding, top + padding, { width: columns[i].width - padding * 2 });
      x += columns[i].width;
    });
    doc.x = MARGIN;
    doc.y = top + height;
  };

  drawRow(columns.map((c) => c.header), true);
  if (rows.length === 0) drawRow([emptyText, ...columns.slice(1).map(() => "")], false);
  rows.forEach((row) => drawRow(row, false));
  doc.moveDown(0.5);
}

function heading(doc: PDFKit.PDFDocument, text: string) {
  if (doc.y > doc.page.height - MARGIN - 60) doc.addPage();
  doc.moveDown(0.8).font("Helvetica-Bold").fontSize(13).fillColor("#111").text(text, MARGIN);
  doc.moveDown(0.3);
}

function loadReportOrder(orderId: string) {
  return prisma.serviceOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      vehicle: { include: { owner: { select: { name: true } } } },
      parts: { orderBy: { createdAt: "asc" }, include: { responsible: { select: { name: true } } } },
      approvals: { orderBy: { createdAt: "asc" }, include: { partUsages: { include: { inventoryPart: { select: { name: true } } } } } },
      assignees: { orderBy: { createdAt: "asc" }, include: { user: { select: { name: true } } } },
    },
  });
}

export type ReportOrder = Awaited<ReturnType<typeof loadReportOrder>>;

export async function buildServiceOrderReportPdf(orderId: string): Promise<Buffer> {
  return renderServiceOrderReportPdf(await loadReportOrder(orderId));
}

export function renderServiceOrderReportPdf(order: ReportOrder): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const vehicle = `${order.vehicle.brand} ${order.vehicle.model} ${order.vehicle.year}`;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, MARGIN, MARGIN, { height: 36 });
    doc.y = MARGIN + 46;
  }
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111").text("Relatório do serviço", MARGIN);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#555")
    .text(`Gerado em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · Etapa atual: ${STATUS_LABELS[order.status as keyof typeof STATUS_LABELS] ?? order.status}`);
  doc.moveDown(0.8);

  const summary: [string, string][] = [
    ["Ordem", order.code],
    ["Cliente", order.vehicle.owner?.name ?? "Não informado"],
    ["Veículo", vehicle],
    ["Placa", order.vehicle.plate ?? "Não informada"],
    ["Quilometragem", `${order.vehicle.mileage.toLocaleString("pt-BR")} km`],
    ["Funcionários", order.assignees.map((a) => a.user.name).join(", ") || "—"],
  ];
  drawTable(
    doc,
    [
      { header: "Dado", width: 130 },
      { header: "Valor", width: width - 130 },
    ],
    summary.map(([label, value]) => [label, value]),
    ""
  );

  heading(doc, "Problemas identificados");
  drawTable(
    doc,
    [
      { header: "Sistema", width: 120 },
      { header: "Status", width: 105 },
      { header: "Observação", width: width - 120 - 105 - 120 },
      { header: "Responsável", width: 120 },
    ],
    order.parts.map((part) => [part.name, PART_STATUS_LABELS[part.status] ?? part.status, part.note ?? "—", part.responsible?.name ?? "—"]),
    "Nenhum problema registrado."
  );

  heading(doc, "Serviços realizados");
  const completed = order.parts.filter((part) => part.status === "DONE");
  doc.font("Helvetica").fontSize(10).fillColor("#111");
  if (completed.length === 0) doc.text("Nenhum problema concluído registrado.", MARGIN);
  completed.forEach((part) => {
    const by = part.responsible?.name ? ` (concluído por ${part.responsible.name})` : "";
    doc.text(`• ${part.name} - ${part.note ?? "Serviço concluído"}${by}`, MARGIN, undefined, { width });
  });

  heading(doc, "Valores do serviço");
  drawTable(
    doc,
    [
      { header: "Problema / serviço", width: 135 },
      { header: "Status", width: 75 },
      { header: "Peças usadas", width: width - 135 - 75 - 210 },
      { header: "Mão de obra", width: 70 },
      { header: "Valor peças", width: 70 },
      { header: "Total", width: 70 },
    ],
    order.approvals.map((approval) => {
      const part = approval.partId ? order.parts.find((p) => p.id === approval.partId) : undefined;
      const status = part
        ? (PART_STATUS_LABELS[part.status] ?? part.status)
        : approval.status === "APPROVED"
          ? "Aprovado"
          : approval.status === "REJECTED"
            ? "Recusado"
            : "Pendente";
      const parts = approval.partUsages.length
        ? approval.partUsages.map((usage) => `${usage.quantity}x ${usage.inventoryPart.name}`).join(", ")
        : "Sem peça vinculada";
      return [
        approval.description,
        status,
        parts,
        currency(approval.laborValue ?? 0),
        currency(approval.partsValue ?? 0),
        currency(approval.estimatedValue ?? 0),
      ];
    }),
    "Nenhum valor de serviço registrado."
  );

  const servicesTotal = order.approvals.reduce((sum, a) => sum + (a.estimatedValue ?? 0), 0) || order.estimatedMin || 0;
  const total = servicesTotal + (order.deliveryExtraValue ?? 0);
  if (order.deliveryExtraValue) {
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(`Valor extra na entrega: ${currency(order.deliveryExtraValue)}`, MARGIN, undefined, { width, align: "right" });
  }
  if (order.deliveryDescription) {
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(`Observação da entrega: ${order.deliveryDescription}`, MARGIN, undefined, { width });
  }
  doc.moveDown(0.5).font("Helvetica-Bold").fontSize(14).fillColor("#111").text(`Valor final: ${currency(total)}`, MARGIN, undefined, { width, align: "right" });

  doc.end();
  return done;
}

/** Gera o PDF, salva (Cloudinary ou /uploads) e registra como mídia DOCUMENT da OS. */
export async function saveServiceOrderReportPdf(orderId: string) {
  const order = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: orderId }, select: { code: true } });
  const buffer = await buildServiceOrderReportPdf(orderId);
  const filename = `${order.code}-servico-${Date.now()}.pdf`;
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.promises.writeFile(filePath, buffer);
  const url = await persistLocalFile(filePath, filename, "application/pdf");
  return prisma.media.create({
    data: { serviceOrderId: orderId, url, type: "DOCUMENT", label: "PDF de finalização do serviço" },
  });
}
