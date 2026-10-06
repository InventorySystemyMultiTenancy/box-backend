import { nextSequenceCode } from "@/lib/order-code";

export function nextEstimateCode() {
  return nextSequenceCode("Estimate_code_seq", "ORC");
}
