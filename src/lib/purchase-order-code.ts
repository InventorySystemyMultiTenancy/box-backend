import { prisma } from "@/lib/prisma";

export async function nextPurchaseOrderCode() {
  const year = new Date().getFullYear();
  const count = await prisma.purchaseOrder.count();
  const seq = String(count + 1).padStart(5, "0");
  return `PC-${year}-${seq}`;
}
