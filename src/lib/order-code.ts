import { prisma } from "@/lib/prisma";

// Usa uma sequência do Postgres (não COUNT(*)) pra garantir número único mesmo com
// criações concorrentes, e pra não reaproveitar um número já usado quando uma ordem é
// excluída — ambos os casos derrubavam a constraint única de `code` com o esquema antigo
// (ver migration 20260928120000_service_order_code_sequence).
export async function nextOrderCode() {
  const year = new Date().getFullYear();
  const [{ nextval }] = await prisma.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('"ServiceOrder_code_seq"') AS nextval`;
  const seq = String(nextval).padStart(5, "0");
  return `OS-${year}-${seq}`;
}
