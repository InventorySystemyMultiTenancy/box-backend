import crypto from "crypto";
import { prisma } from "@/lib/prisma";

export class ShareLinkError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const LINK_DURATION_DAYS = 30;

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function isActive(link: { revokedAt: Date | null; expiresAt: Date }) {
  return !link.revokedAt && link.expiresAt.getTime() > Date.now();
}

export async function getActiveShareLink(serviceOrderId: string) {
  const link = await prisma.serviceOrderShareLink.findUnique({ where: { serviceOrderId } });
  return link && isActive(link) ? link : null;
}

// Gerar quando já existe um link ativo só devolve o mesmo — não reseta o prazo nem
// invalida o link que já pode ter sido mandado pro cliente. Pra trocar de fato (link
// vazou, por exemplo), revogar antes com revokeShareLink.
export async function createOrGetShareLink(serviceOrderId: string, createdById: string) {
  const existing = await getActiveShareLink(serviceOrderId);
  if (existing) return existing;

  const expiresAt = new Date(Date.now() + LINK_DURATION_DAYS * 24 * 60 * 60 * 1000);
  return prisma.serviceOrderShareLink.upsert({
    where: { serviceOrderId },
    create: { serviceOrderId, token: generateToken(), expiresAt, createdById },
    update: { token: generateToken(), expiresAt, revokedAt: null, createdById },
  });
}

export async function revokeShareLink(serviceOrderId: string) {
  const link = await prisma.serviceOrderShareLink.findUnique({ where: { serviceOrderId } });
  if (!link) throw new ShareLinkError("Nenhum link para esta ordem.", 404);
  await prisma.serviceOrderShareLink.update({ where: { serviceOrderId }, data: { revokedAt: new Date() } });
}

// Só a validação + o id da ordem — usado pelo socket (join-order-public) pra colocar
// quem está com o link na mesma sala (order:<id>) que já recebe os eventos em tempo
// real de status/timeline/peça/aprovação, sem duplicar a lógica de validação do token.
export async function resolveShareLinkOrderId(token: string): Promise<string> {
  const link = await prisma.serviceOrderShareLink.findUnique({ where: { token } });
  if (!link || !isActive(link)) {
    throw new ShareLinkError("Este link não é mais válido — pode ter expirado ou sido revogado.", 404);
  }
  return link.serviceOrderId;
}

const publicOrderInclude = {
  vehicle: { include: { owner: { select: { name: true } } } },
  timelineEvents: { orderBy: { occurredAt: "asc" as const }, include: { media: true } },
  parts: { include: { media: true } },
  approvals: {
    orderBy: { createdAt: "desc" as const },
    include: { partUsages: { include: { inventoryPart: { select: { name: true } } } }, media: true },
  },
  media: { orderBy: { createdAt: "desc" as const } },
};

function mapMedia(m: {
  id: string;
  url: string;
  type: string;
  label: string | null;
  isDeliveryPhoto: boolean;
  isDamagePhoto: boolean;
  createdAt: Date;
}) {
  return {
    id: m.id,
    url: m.url,
    type: m.type,
    label: m.label,
    isDeliveryPhoto: m.isDeliveryPhoto,
    isDamagePhoto: m.isDamagePhoto,
    createdAt: m.createdAt,
  };
}

// Retrato deliberadamente restrito da ordem — só o que a pessoa com o link deve ver
// (status, preço, peças, fotos, timeline). Nunca inclui dados internos de operação
// (consultor/orçamentista/técnico responsável, seguro/sinistro, custo de peça) nem nada
// que sirva pra realizar uma ação — o token nunca autentica escrita, só esta leitura.
export async function resolvePublicShareLink(token: string) {
  const link = await prisma.serviceOrderShareLink.findUnique({ where: { token } });
  if (!link || !isActive(link)) {
    throw new ShareLinkError("Este link não é mais válido — pode ter expirado ou sido revogado. Fale com a oficina.", 404);
  }

  const order = await prisma.serviceOrder.findUnique({ where: { id: link.serviceOrderId }, include: publicOrderInclude });
  if (!order) throw new ShareLinkError("Projeto não encontrado.", 404);

  return {
    code: order.code,
    status: order.status,
    progress: order.progress,
    receivedAt: order.receivedAt,
    completedAt: order.completedAt,
    deliveryDescription: order.deliveryDescription,
    deliveryExtraValue: order.deliveryExtraValue,
    linkExpiresAt: link.expiresAt,
    vehicle: {
      brand: order.vehicle.brand,
      model: order.vehicle.model,
      year: order.vehicle.year,
      plate: order.vehicle.plate,
      mileage: order.vehicle.mileage,
      ownerName: order.vehicle.owner?.name ?? null,
    },
    timelineEvents: order.timelineEvents.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      occurredAt: e.occurredAt,
      done: e.done,
      media: e.media.map(mapMedia),
    })),
    parts: order.parts.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      status: p.status,
      note: p.note,
      warranty: p.warranty,
      updatedAt: p.updatedAt,
      media: p.media.map(mapMedia),
    })),
    approvals: order.approvals.map((a) => ({
      id: a.id,
      partId: a.partId,
      title: a.title,
      description: a.description,
      status: a.status,
      laborValue: a.laborValue,
      partsValue: a.partsValue,
      estimatedValue: a.estimatedValue,
      note: a.note,
      responseNote: a.responseNote,
      createdAt: a.createdAt,
      partUsages: a.partUsages.map((u) => ({ id: u.id, quantity: u.quantity, partName: u.inventoryPart.name })),
      media: a.media.map(mapMedia),
    })),
    media: order.media.map(mapMedia),
  };
}

export type PublicServiceOrder = Awaited<ReturnType<typeof resolvePublicShareLink>>;
