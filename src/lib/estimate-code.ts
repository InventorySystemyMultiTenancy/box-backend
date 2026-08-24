import { prisma } from "@/lib/prisma";

export async function nextEstimateCode() {
  const year = new Date().getFullYear();
  const count = await prisma.estimate.count();
  const seq = String(count + 1).padStart(5, "0");
  return `ORC-${year}-${seq}`;
}
