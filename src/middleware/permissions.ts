import { Response, NextFunction } from "express-serve-static-core";
import { AuthedRequest } from "@/middleware/auth";
import { hasPermission } from "@/services/permissions.service";

// Exige uma permissão granular (cargo + exceções), independente do `role` legado.
// Aplicado só nos módulos novos (Clientes, Cargos) — rotas antigas continuam com requireRole.
export function requirePermission(resource: string, action: string) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Token ausente." });
    }
    const allowed = await hasPermission(req.user.id, resource, action);
    if (!allowed) {
      return res.status(403).json({ error: "Você não tem permissão para esta ação." });
    }
    next();
  };
}
