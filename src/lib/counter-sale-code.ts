import { prisma } from "@/lib/prisma";

export async function nextCounterSaleCode() {
  const year = new Date().getFullYear();
  const count = await prisma.counterSale.count();
  const seq = String(count + 1).padStart(5, "0");
  return `PDV-${year}-${seq}`;
}
