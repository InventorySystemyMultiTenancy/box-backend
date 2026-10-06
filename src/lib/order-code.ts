import { prisma } from "@/lib/prisma";

// Usa uma sequência do Postgres (não COUNT(*)) pra garantir número único mesmo com
// criações concorrentes, e pra não reaproveitar um número já usado quando um registro é
// excluído — ambos os casos derrubavam a constraint única de `code` com o esquema antigo
// (ver migrations 20260928120000_service_order_code_sequence e 20261006120000_document_code_sequences).
// `sequenceName` vem sempre de uma constante deste projeto, nunca de entrada do usuário.
export async function nextSequenceCode(sequenceName: string, prefix: string) {
  const year = new Date().getFullYear();
  const [{ nextval }] = await prisma.$queryRawUnsafe<{ nextval: bigint }[]>(`SELECT nextval('"${sequenceName}"') AS nextval`);
  const seq = String(nextval).padStart(5, "0");
  return `${prefix}-${year}-${seq}`;
}

export function nextOrderCode() {
  return nextSequenceCode("ServiceOrder_code_seq", "OS");
}
