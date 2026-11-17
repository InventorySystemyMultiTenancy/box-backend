import { NextFunction, Request, Response } from "express";

/**
 * Uma linha de log por requisição de login/sessão e por toda resposta de erro (4xx/5xx),
 * para dar pra investigar no painel do Render casos como "o celular volta pro login".
 * Nunca grava token, senha, e-mail nem corpo da requisição — só método, caminho, status,
 * tempo, motivo da recusa (quando houver), id do usuário e o tipo de aparelho.
 */
function device(ua: string | undefined) {
  if (!ua) return "?";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : "outro";
  const browser = /SamsungBrowser/.test(ua) ? "Samsung" : /EdgA?\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "outro";
  return `${os}/${browser}`;
}

export function requestLog(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on("finish", () => {
    const path = req.originalUrl.split("?")[0];
    if (req.method === "OPTIONS") return;
    const isAuth = path.startsWith("/api/auth/");
    if (!isAuth && res.statusCode < 400) return;
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? res.locals.userId;
    const parts = [
      `[req] ${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`,
      res.locals.authFail ? `motivo=${res.locals.authFail}` : "",
      userId ? `user=${userId}` : "",
      res.getHeader("X-Renewed-Token") ? "renovado" : "",
      `ip=${req.ip}`,
      device(req.headers["user-agent"]),
    ];
    console.log(parts.filter(Boolean).join(" "));
  });
  next();
}
