import { prisma } from "@/lib/prisma";

export class DocumentTemplateError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const DEFAULT_TEMPLATES: { key: string; name: string; bodyHtml: string }[] = [
  {
    key: "RECEIPT",
    name: "Recibo",
    bodyHtml:
      "<h1>Recibo</h1><p>Recebemos de <strong>{{payer}}</strong> a quantia de <strong>{{amount}}</strong> referente a {{description}}.</p><p>Forma de pagamento: {{paymentMethod}}</p><p>Data: {{date}}</p>",
  },
  {
    key: "AUTHORIZATION",
    name: "Autorização de serviço",
    bodyHtml:
      "<h1>Autorização de serviço</h1><p>Autorizo a execução dos serviços descritos na OS {{orderCode}} no veículo {{vehicle}}, placa {{plate}}, de propriedade de {{client}}.</p><p>Data: {{date}}</p>",
  },
  {
    key: "DELIVERY_TERM",
    name: "Termo de entrega",
    bodyHtml:
      "<h1>Termo de entrega</h1><p>Declaro ter recebido o veículo {{vehicle}}, placa {{plate}}, referente à OS {{orderCode}}, em perfeitas condições e de acordo com os serviços contratados.</p><p>Data: {{date}}</p>",
  },
  {
    key: "LIABILITY_TERM",
    name: "Termo de responsabilidade",
    bodyHtml:
      "<h1>Termo de responsabilidade</h1><p>{{client}} declara estar ciente e de acordo com os termos do serviço prestado na OS {{orderCode}}.</p><p>Data: {{date}}</p>",
  },
  {
    key: "SUPPLEMENT_REQUEST",
    name: "Solicitação de complemento",
    bodyHtml:
      "<h1>Solicitação de complemento de mão de obra</h1><p>OS {{orderCode}} — {{vehicle}}, placa {{plate}}.</p><p>Serviço adicional: {{title}}</p><p>Justificativa: {{justification}}</p>",
  },
];

// Garante os templates padrão na primeira chamada (idempotente), sem depender do
// seed.ts (que reseta todo o banco).
export async function ensureDefaultTemplates() {
  const count = await prisma.documentTemplate.count();
  if (count > 0) return;
  await prisma.documentTemplate.createMany({ data: DEFAULT_TEMPLATES });
}

export async function listDocumentTemplates() {
  await ensureDefaultTemplates();
  return prisma.documentTemplate.findMany({ where: { active: true }, orderBy: { name: "asc" } });
}

export async function updateDocumentTemplate(key: string, input: { name?: string; bodyHtml?: string; active?: boolean }) {
  await ensureDefaultTemplates();
  const template = await prisma.documentTemplate.findUnique({ where: { key } });
  if (!template) throw new DocumentTemplateError("Template não encontrado.", 404);
  return prisma.documentTemplate.update({ where: { key }, data: input });
}

// Substituição simples de placeholders {{campo}} — suficiente para os templates
// lineares acima; não é um motor de template genérico.
export function renderTemplate(bodyHtml: string, context: Record<string, string | number | undefined | null>) {
  return bodyHtml.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = context[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export async function renderDocument(key: string, context: Record<string, string | number | undefined | null>) {
  await ensureDefaultTemplates();
  const template = await prisma.documentTemplate.findUnique({ where: { key } });
  if (!template) throw new DocumentTemplateError("Template não encontrado.", 404);
  return { name: template.name, html: renderTemplate(template.bodyHtml, context) };
}
