import { NextFunction, Request, Response, ParamsDictionary } from "express-serve-static-core";
import { verifyToken } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";

export interface AuthedRequest<P extends ParamsDictionary = ParamsDictionary> extends Request<P> {
  user?: { id: string; role: string };
}

/**
 * Valida o token e confere o usuário no banco a cada requisição: um funcionário desativado
 * perde o acesso na hora (mesmo com token ainda válido), e uma troca de perfil feita pelo
 * admin vale imediatamente — o `role` usado é sempre o atual, não o gravado no token.
 */
export async function resolveTokenUser(token: string) {
  const payload = verifyToken(token);
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true, active: true } });
  if (!user || !user.active) return null;
  return { id: user.id, role: user.role };
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token ausente." });
  }
  let user: { id: string; role: string } | null;
  try {
    user = await resolveTokenUser(header.slice(7));
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
  if (!user) return res.status(401).json({ error: "Sua conta está desativada ou não existe mais." });
  req.user = user;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Você não tem permissão para esta ação." });
    }
    next();
  };
}
