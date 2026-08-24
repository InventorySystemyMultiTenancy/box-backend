import { prisma } from "@/lib/prisma";

export interface AuditEntry {
  userId?: string | null;
  action: "CREATE" | "UPDATE" | "DELETE" | "STATUS_CHANGE";
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

// Log de auditoria técnica/administrativa — distinto do TimelineEvent (histórico de
// negócio voltado ao cliente). Nunca deve derrubar a operação principal se falhar.
export async function recordAudit(entry: AuditEntry) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? undefined,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        before: entry.before !== undefined ? JSON.stringify(entry.before) : undefined,
        after: entry.after !== undefined ? JSON.stringify(entry.after) : undefined,
      },
    });
  } catch (err) {
    console.error("Falha ao gravar audit log", err);
  }
}

export async function listAuditLogs(query: Record<string, unknown>) {
  const entity = typeof query.entity === "string" ? query.entity : undefined;
  const entityId = typeof query.entityId === "string" ? query.entityId : undefined;
  const userId = typeof query.userId === "string" ? query.userId : undefined;

  return prisma.auditLog.findMany({
    where: { ...(entity ? { entity } : {}), ...(entityId ? { entityId } : {}), ...(userId ? { userId } : {}) },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
