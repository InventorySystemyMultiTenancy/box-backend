import { prisma } from "@/lib/prisma";

// Blocos da aba Relatórios que podem ser liberados por cargo (Role.reportSections).
// Espelhado em REPORT_SECTIONS no frontend (lib/access.ts) — manter os dois iguais.
export const REPORT_SECTIONS = ["indicators", "productivity", "revision", "parts", "financial"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

// Tipos de alerta que podem ser liberados por cargo (Role.alertTypes). Os dois últimos são
// os lembretes para clientes (montados na própria aba Alertas, não gravados como Notification).
export const ALERT_TYPES = [
  "STALE_STATUS",
  "DELIVERY_TOMORROW",
  "SUPPLEMENT_PENDING",
  "INSPECTION_TODAY",
  "PAYABLE_OVERDUE",
  "REVISION_REMINDER",
  "WARRANTY_REMINDER",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** null = sem restrição (lista vazia no cargo, ou usuário sem cargo). */
export interface ReportAccess {
  sections: ReportSection[] | null;
  sectors: string[] | null;
  alertTypes: AlertType[] | null;
}

const orNull = <T>(list: T[] | undefined | null) => (list && list.length > 0 ? list : null);

export async function getReportAccess(userId: string): Promise<ReportAccess> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { roleRef: { select: { reportSections: true, expenseSectors: true, alertTypes: true } } },
  });
  const role = user?.roleRef;
  return {
    sections: orNull(role?.reportSections.filter((s): s is ReportSection => (REPORT_SECTIONS as readonly string[]).includes(s))),
    sectors: orNull(role?.expenseSectors),
    alertTypes: orNull(role?.alertTypes.filter((t): t is AlertType => (ALERT_TYPES as readonly string[]).includes(t))),
  };
}

export function canSeeSection(access: ReportAccess, section: ReportSection) {
  return access.sections === null || access.sections.includes(section);
}

export function canSeeAlertType(access: ReportAccess, type: string) {
  return access.alertTypes === null || (access.alertTypes as string[]).includes(type);
}

/** Setor de despesa liberado? (comparação sem diferenciar maiúsculas/espaços) */
export function canSeeSector(access: ReportAccess, sector: string | null | undefined) {
  if (access.sectors === null) return true;
  const s = sector?.trim().toLowerCase();
  return Boolean(s) && access.sectors.some((allowed) => allowed.trim().toLowerCase() === s);
}
