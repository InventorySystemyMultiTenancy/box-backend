import { prisma } from "@/lib/prisma";

/**
 * IDs dos veículos cuja placa contém o termo, comparando só letras e números — "abc1234"
 * acha "ABC-1234" (e o contrário): ninguém digita o traço. Termo com menos de 3 letras/
 * números não busca nada (evita trazer meia frota com "1").
 */
export async function vehicleIdsMatchingPlate(term: string): Promise<string[]> {
  const compact = term.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (compact.length < 3) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Vehicle"
    WHERE regexp_replace(upper(coalesce("plate", '')), '[^A-Z0-9]', '', 'g') LIKE ${`%${compact}%`}
    LIMIT 500`;
  return rows.map((r) => r.id);
}
