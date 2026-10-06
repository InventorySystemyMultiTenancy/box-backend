import { prisma } from "@/lib/prisma";
import { refreshAlerts } from "@/services/alerts.service";

// Rotina em segundo plano dentro do próprio processo (não há fila/cron externo no projeto):
// recalcula os alertas (OS parada, contas vencidas, vistoria hoje, entrega
// amanhã) e marca contas vencidas como OVERDUE de hora em hora — antes isso só acontecia
// quando alguém abria a aba Alertas ou a listagem de contas. Num servidor que "dorme" sem
// acesso (plano gratuito do Render), roda de novo assim que ele acorda.
const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;

export async function runHousekeeping() {
  const now = new Date();
  await prisma.accountPayable.updateMany({ where: { status: "PENDING", dueDate: { lt: now } }, data: { status: "OVERDUE" } });
  await prisma.accountReceivable.updateMany({ where: { status: "PENDING", dueDate: { lt: now } }, data: { status: "OVERDUE" } });
  await refreshAlerts();
}

export function startScheduler() {
  if (process.env.DISABLE_SCHEDULER === "true") return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runHousekeeping();
    } catch (err) {
      console.error("Falha na rotina automática de alertas:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref();
  setInterval(tick, INTERVAL_MS).unref();
}
