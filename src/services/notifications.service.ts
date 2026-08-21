import { prisma } from "@/lib/prisma";
import { NotificationProvider } from "@/services/notifications/notification-provider";
import { MockNotificationProvider } from "@/services/notifications/mock-provider";
import { ServiceOrderStatus } from "@/lib/constants";

// Ponto único de troca do gateway de notificação — plugar um provider real aqui quando
// a oficina tiver contrato com uma operadora/API de WhatsApp Business.
const provider: NotificationProvider = new MockNotificationProvider();

const STATUS_MESSAGE: Partial<Record<ServiceOrderStatus, string>> = {
  RECEIVED: "seu veículo deu entrada na oficina.",
  AWAITING_DIAGNOSIS: "seu veículo está aguardando diagnóstico.",
  DIAGNOSIS_DONE: "o diagnóstico do seu veículo foi concluído.",
  AWAITING_APPROVAL: "há um orçamento aguardando sua aprovação.",
  IN_PROGRESS: "a reparação do seu veículo está em andamento.",
  TESTING: "seu veículo está em teste de rodagem.",
  WASHING: "seu veículo está sendo lavado.",
  FINISHED: "o serviço no seu veículo foi finalizado.",
  READY_FOR_PICKUP: "seu veículo está pronto para retirada!",
};

// Dispara uma notificação de mudança de status para o dono do veículo — chamada como
// fire-and-forget (nunca deve derrubar a requisição que mudou o status).
export async function notifyServiceOrderStatus(orderId: string) {
  const order = await prisma.serviceOrder.findUnique({
    where: { id: orderId },
    include: { vehicle: { include: { owner: true } } },
  });
  if (!order) return;

  const text = STATUS_MESSAGE[order.status as ServiceOrderStatus];
  if (!text) return;

  const to = order.vehicle.owner.phone;
  if (!to) return;

  const message = `Olá ${order.vehicle.owner.name.split(" ")[0]}, ${text} (OS ${order.code})`;
  await sendAndLog({ channel: "WHATSAPP", to, message, serviceOrderId: order.id });
}

export async function sendAndLog(input: { channel: "SMS" | "WHATSAPP"; to: string; message: string; serviceOrderId?: string }) {
  try {
    await provider.send({ channel: input.channel, to: input.to, message: input.message });
    await prisma.notificationLog.create({
      data: {
        channel: input.channel,
        to: input.to,
        message: input.message,
        status: "SENT",
        serviceOrderId: input.serviceOrderId,
        provider: provider.name,
      },
    });
  } catch (err) {
    await prisma.notificationLog.create({
      data: {
        channel: input.channel,
        to: input.to,
        message: input.message,
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : "Falha ao enviar.",
        serviceOrderId: input.serviceOrderId,
        provider: provider.name,
      },
    });
  }
}

export async function listNotifications(query: Record<string, unknown>) {
  const serviceOrderId = typeof query.serviceOrderId === "string" ? query.serviceOrderId : undefined;
  return prisma.notificationLog.findMany({
    where: { ...(serviceOrderId ? { serviceOrderId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
