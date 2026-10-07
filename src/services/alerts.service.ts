import { prisma, AppTx } from "@/lib/prisma";
import { ReportAccess, canSeeAlertType, canSeeSector } from "@/lib/report-access";
import { STALE_STATUS_ALERT_DAYS, SUPPLEMENT_PENDING_ALERT_DAYS } from "@/lib/constants";

interface AlertCandidate {
  type: string;
  entity: string;
  entityId: string;
  message: string;
}

async function computeCandidates(): Promise<AlertCandidate[]> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_STATUS_ALERT_DAYS * 24 * 60 * 60 * 1000);
  const supplementThreshold = new Date(now.getTime() - SUPPLEMENT_PENDING_ALERT_DAYS * 24 * 60 * 60 * 1000);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const tomorrowStart = new Date(now);
  tomorrowStart.setDate(now.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setHours(23, 59, 59, 999);

  // Só projetos em andamento geram alerta: finalizado, pronto para retirada ou com baixa
  // dada não é mais pendência da oficina (projeto excluído some sozinho — não existe mais).
  const activeOrder = { archivedAt: null, status: { notIn: ["FINISHED", "READY_FOR_PICKUP"] } };

  const [staleOrders, pendingSupplements, inspectionsToday, deliveriesTomorrow, overduePayables] = await Promise.all([
    prisma.serviceOrder.findMany({
      where: { ...activeOrder, updatedAt: { lte: staleThreshold } },
      include: { vehicle: true },
    }),
    prisma.approval.findMany({
      where: { kind: "SUPPLEMENT", status: "PENDING", createdAt: { lte: supplementThreshold }, serviceOrder: activeOrder },
      include: { serviceOrder: { include: { vehicle: true } } },
    }),
    prisma.inspection.findMany({
      where: { status: "SCHEDULED", scheduledAt: { gte: todayStart, lte: todayEnd }, serviceOrder: activeOrder },
      include: { serviceOrder: { include: { vehicle: true } } },
    }),
    prisma.serviceOrder.findMany({
      where: { ...activeOrder, deliveryForecastAt: { gte: tomorrowStart, lte: tomorrowEnd } },
      include: { vehicle: true },
    }),
    // Checa a dueDate diretamente (não confia em status já estar "OVERDUE" — esse
    // flip só acontece quando a listagem de contas a pagar é consultada).
    prisma.accountPayable.findMany({
      where: { status: { notIn: ["PAID", "CANCELLED"] }, dueDate: { lt: now } },
    }),
  ]);

  const candidates: AlertCandidate[] = [];

  for (const order of staleOrders) {
    const days = Math.floor((Date.now() - order.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
    candidates.push({
      type: "STALE_STATUS",
      entity: "ServiceOrder",
      entityId: order.id,
      message: `Veículo ${order.vehicle.plate ?? order.vehicle.model} está há ${days} dias sem mudança de status (${order.code}).`,
    });
  }
  for (const approval of pendingSupplements) {
    const days = Math.floor((Date.now() - approval.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    candidates.push({
      type: "SUPPLEMENT_PENDING",
      entity: "Approval",
      entityId: approval.id,
      message: `Complemento pendente há ${days} dias — ${approval.serviceOrder.code} (${approval.serviceOrder.vehicle.plate ?? approval.serviceOrder.vehicle.model}).`,
    });
  }
  for (const inspection of inspectionsToday) {
    candidates.push({
      type: "INSPECTION_TODAY",
      entity: "Inspection",
      entityId: inspection.id,
      message: `Vistoria marcada para hoje — ${inspection.serviceOrder.code} (${inspection.serviceOrder.vehicle.plate ?? inspection.serviceOrder.vehicle.model}).`,
    });
  }
  for (const order of deliveriesTomorrow) {
    candidates.push({
      type: "DELIVERY_TOMORROW",
      entity: "ServiceOrder",
      entityId: order.id,
      message: `Entrega prevista para amanhã — ${order.code} (${order.vehicle.plate ?? order.vehicle.model}).`,
    });
  }
  for (const payable of overduePayables) {
    const days = Math.floor((Date.now() - payable.dueDate.getTime()) / (1000 * 60 * 60 * 24));
    candidates.push({
      type: "PAYABLE_OVERDUE",
      entity: "AccountPayable",
      entityId: payable.id,
      message: `Conta a pagar vencida há ${days} dia${days === 1 ? "" : "s"} — ${payable.description} (${payable.payeeName}), R$ ${payable.amount.toFixed(2)}.`,
    });
  }

  return candidates;
}

function alertKey(alert: { type: string; entity: string | null; entityId: string | null }) {
  return `${alert.type}|${alert.entity ?? ""}|${alert.entityId ?? ""}`;
}

interface StoredAlert {
  id: string;
  type: string;
  entity: string | null;
  entityId: string | null;
  message: string;
  read: boolean;
}

/**
 * Sincroniza os alertas gravados com as regras (função pura, coberta por alerts.test.ts):
 * - situação que não existe mais (conta cancelada/paga, projeto finalizado ou excluído,
 *   OS que voltou a andar...) → o alerta é apagado — se acontecer de novo, alerta de novo;
 * - "Marcar como lido" vale enquanto a situação for a mesma: o registro lido fica guardado
 *   e impede recriar o mesmo alerta (antes ele voltava na hora, como se o clique falhasse);
 * - duplicados do mesmo tipo+registro (criados por esse bug antigo) viram um só — se algum
 *   foi marcado como lido, prevalece o lido.
 */
export function planAlertSync(stored: StoredAlert[], candidates: AlertCandidate[]) {
  const candidateByKey = new Map(candidates.map((c) => [alertKey(c), c]));
  const byKey = new Map<string, StoredAlert[]>();
  for (const alert of stored) byKey.set(alertKey(alert), [...(byKey.get(alertKey(alert)) ?? []), alert]);

  const deleteIds: string[] = [];
  const updates: { id: string; message: string }[] = [];
  for (const [key, alerts] of byKey) {
    const candidate = candidateByKey.get(key);
    if (!candidate) {
      deleteIds.push(...alerts.map((a) => a.id));
      continue;
    }
    const keep = alerts.find((a) => a.read) ?? alerts[0];
    deleteIds.push(...alerts.filter((a) => a.id !== keep.id).map((a) => a.id));
    if (!keep.read && keep.message !== candidate.message) updates.push({ id: keep.id, message: candidate.message });
  }
  const create = candidates.filter((c) => !byKey.has(alertKey(c)));
  return { deleteIds, updates, create };
}

// Gera/atualiza/retira os alertas conforme as regras. Chamado sob demanda (GET /api/alerts)
// e pela rotina de hora em hora (jobs/scheduler.ts). Todos os tipos de alerta são gerados
// por regra — inclusive os antigos de "estoque baixo", que somem por não terem mais regra.
export async function refreshAlerts() {
  const candidates = await computeCandidates();
  const stored = await prisma.notification.findMany({
    select: { id: true, type: true, entity: true, entityId: true, message: true, read: true },
  });
  const plan = planAlertSync(stored, candidates);

  if (plan.deleteIds.length > 0) await prisma.notification.deleteMany({ where: { id: { in: plan.deleteIds } } });
  for (const update of plan.updates) {
    await prisma.notification.update({ where: { id: update.id }, data: { message: update.message } });
  }
  if (plan.create.length > 0) await prisma.notification.createMany({ data: plan.create });

  return prisma.notification.findMany({ where: { read: false }, orderBy: { createdAt: "desc" } });
}

/**
 * Só os alertas que o cargo do usuário pode ver: tipos liberados (Role.alertTypes) e, nas
 * contas a pagar vencidas, só as dos setores de despesa liberados (Role.expenseSectors).
 */
export async function filterAlertsForAccess<T extends { type: string; entity: string | null; entityId: string | null }>(
  alerts: T[],
  access: ReportAccess
) {
  const byType = alerts.filter((a) => canSeeAlertType(access, a.type));
  if (access.sectors === null) return byType;

  const payableIds = byType.filter((a) => a.entity === "AccountPayable" && a.entityId).map((a) => a.entityId!);
  const payables = payableIds.length
    ? await prisma.accountPayable.findMany({ where: { id: { in: payableIds } }, select: { id: true, expenseSector: true } })
    : [];
  const sectorById = new Map(payables.map((p) => [p.id, p.expenseSector]));
  return byType.filter((a) => a.entity !== "AccountPayable" || canSeeSector(access, sectorById.get(a.entityId ?? "")));
}

/**
 * Retira na hora todos os alertas ligados a um projeto (OS parada, entrega amanhã,
 * complemento pendente, vistoria hoje) — usado ao excluir, finalizar ou dar baixa, pra
 * não ficar alerta de projeto que já saiu do andamento até a próxima atualização.
 */
export async function clearServiceOrderAlerts(db: Pick<AppTx, "notification" | "approval" | "inspection">, serviceOrderId: string) {
  const [approvals, inspections] = await Promise.all([
    db.approval.findMany({ where: { serviceOrderId }, select: { id: true } }),
    db.inspection.findMany({ where: { serviceOrderId }, select: { id: true } }),
  ]);
  await db.notification.deleteMany({
    where: {
      OR: [
        { entity: "ServiceOrder", entityId: serviceOrderId },
        { entity: "Approval", entityId: { in: approvals.map((a) => a.id) } },
        { entity: "Inspection", entityId: { in: inspections.map((i) => i.id) } },
      ],
    },
  });
}

// Marca como lido também os eventuais duplicados do mesmo tipo+registro, pra nenhum
// continuar aparecendo depois do clique.
export async function markAlertRead(id: string) {
  const notification = await prisma.notification.findUnique({ where: { id } });
  // Já foi retirado (situação resolvida entre um clique e outro) — nada a fazer.
  if (!notification) return null;
  await prisma.notification.updateMany({
    where: { type: notification.type, entity: notification.entity, entityId: notification.entityId, read: false },
    data: { read: true },
  });
  return { ...notification, read: true };
}
