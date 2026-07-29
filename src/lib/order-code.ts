import { prisma } from "@/lib/prisma";

export async function nextOrderCode() {
  const year = new Date().getFullYear();
  const count = await prisma.serviceOrder.count();
  const seq = String(count + 1000 + 1).padStart(5, "0");
  return `OS-${year}-${seq}`;
}
