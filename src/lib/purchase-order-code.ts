import { nextSequenceCode } from "@/lib/order-code";

export function nextPurchaseOrderCode() {
  return nextSequenceCode("PurchaseOrder_code_seq", "PC");
}
