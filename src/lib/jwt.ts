import jwt from "jsonwebtoken";

if (!process.env.JWT_SECRET && process.env.NODE_ENV === "production") {
  // Sem segredo próprio, qualquer um que conheça o valor padrão abaixo forjaria tokens.
  throw new Error("JWT_SECRET não definido — configure a variável de ambiente antes de subir em produção.");
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-in-production";
// Sessão: o token vale JWT_EXPIRES_IN e é renovado a cada uso (ver requireAuth), então na
// prática a pessoa só é deslogada depois desse tempo SEM usar o sistema (padrão 3 horas).
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "3h";
/** Token com mais que isto de idade ganha um novo a cada requisição autenticada. */
export const TOKEN_RENEW_AFTER_SECONDS = 10 * 60;

export interface TokenPayload {
  sub: string;
  role: string;
  iat?: number;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
