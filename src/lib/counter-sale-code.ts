import { nextSequenceCode } from "@/lib/order-code";

export function nextCounterSaleCode() {
  return nextSequenceCode("CounterSale_code_seq", "PDV");
}
