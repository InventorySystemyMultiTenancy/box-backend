import { Router } from "express";
import { requireAuth, requireRole } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { getDashboardReport, getFinancialReport, getHomeKpis, getServiceOrderProfitability } from "@/services/reports.service";
import { AuthedRequest } from "@/middleware/auth";
import { canSeeSection, getReportAccess } from "@/lib/report-access";

export const reportsRouter = Router();

// Blocos que o cargo não libera (Role.reportSections) voltam como null — o frontend
// esconde, e os números nem chegam ao navegador.
reportsRouter.get("/dashboard", requireAuth, requirePermission("reports", "view"), async (req: AuthedRequest, res) => {
  const [report, access] = await Promise.all([
    getDashboardReport(req.query as { from?: string; to?: string }),
    getReportAccess(req.user!.id),
  ]);
  const indicators = canSeeSection(access, "indicators");
  res.json({
    report: {
      revenue: indicators ? report.revenue : null,
      approvalStats: indicators ? report.approvalStats : null,
      quoteStats: indicators ? report.quoteStats : null,
      averageRepairTime: indicators ? report.averageRepairTime : null,
      occupancy: indicators ? report.occupancy : null,
      stages: indicators ? report.stages : null,
      mechanicProductivity: canSeeSection(access, "productivity") ? report.mechanicProductivity : null,
      partsUsage: canSeeSection(access, "parts") ? report.partsUsage : null,
    },
  });
});

// PDF financeiro do período — exige o bloco "financial" e já vem recortado pelos setores
// de despesa do cargo (Role.expenseSectors).
reportsRouter.get("/financial", requireAuth, requirePermission("reports", "view"), async (req: AuthedRequest, res) => {
  const access = await getReportAccess(req.user!.id);
  if (!canSeeSection(access, "financial")) {
    return res.status(403).json({ error: "Seu cargo não tem acesso ao relatório financeiro." });
  }
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  const report = await getFinancialReport({ from, to }, access.sectors);
  res.json({ report });
});

// Indicadores do topo da aba Projetos — só admin (mecânico não vê valores, ver hidePricesForMechanic).
reportsRouter.get("/kpis", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const kpis = await getHomeKpis();
  res.json({ kpis });
});

reportsRouter.get(
  "/service-orders/:id/profitability",
  requireAuth,
  requirePermission("reports", "view"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const profitability = await getServiceOrderProfitability(req.params.id);
    res.json({ profitability });
  }
);
