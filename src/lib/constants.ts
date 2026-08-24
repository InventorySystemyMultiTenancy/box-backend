// Mesma taxonomia de status usada no dashboard (frontendmecanic) e descrita
// na especificação de experiência — mudar aqui exige espelhar no frontend.

export const SERVICE_ORDER_STATUSES = [
  "SCHEDULED",
  "RECEIVED",
  "AWAITING_DIAGNOSIS",
  "DIAGNOSIS_DONE",
  "AWAITING_APPROVAL",
  "PARTS_REQUESTED",
  "PARTS_RECEIVED",
  "IN_PROGRESS",
  "TESTING",
  "WASHING",
  "FINISHED",
  "READY_FOR_PICKUP",
] as const;

export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number];

// Progresso sugerido (%) por status, usado como fallback quando nenhum
// valor manual é informado ao mudar de estado.
export const STATUS_PROGRESS: Record<ServiceOrderStatus, number> = {
  SCHEDULED: 2,
  RECEIVED: 5,
  AWAITING_DIAGNOSIS: 15,
  DIAGNOSIS_DONE: 25,
  AWAITING_APPROVAL: 35,
  PARTS_REQUESTED: 45,
  PARTS_RECEIVED: 55,
  IN_PROGRESS: 65,
  TESTING: 85,
  WASHING: 92,
  FINISHED: 97,
  READY_FOR_PICKUP: 100,
} as const;

// Rótulo em pt-BR de cada status — espelha STATUS_LABELS do frontend (lib/types.ts).
// Usado para gerar o texto do evento de timeline e da mensagem de WhatsApp ao avançar etapa.
export const STATUS_LABELS: Record<ServiceOrderStatus, string> = {
  SCHEDULED: "Agendado — aguardando veículo",
  RECEIVED: "Veículo recebido",
  AWAITING_DIAGNOSIS: "Aguardando diagnóstico",
  DIAGNOSIS_DONE: "Diagnóstico concluído",
  AWAITING_APPROVAL: "Aguardando aprovação",
  PARTS_REQUESTED: "Peças solicitadas",
  PARTS_RECEIVED: "Peças recebidas",
  IN_PROGRESS: "Reparação em andamento",
  TESTING: "Testes",
  WASHING: "Lavagem",
  FINISHED: "Finalizado",
  READY_FOR_PICKUP: "Pronto para retirada",
};

export const PART_STATUSES = [
  "NOT_INSPECTED",
  "IN_PROGRESS",
  "WARNING",
  "CRITICAL",
  "DONE",
] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

export const PART_KEYS = [
  "motor",
  "freios",
  "suspensao",
  "transmissao",
  "escapamento",
  "eletrica",
  "arcondicionado",
  "direcao",
  "pneus",
  "bateria",
  "arrefecimento",
  "combustivel",
  "carroceria",
] as const;
export type PartKey = (typeof PART_KEYS)[number];

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export const MEDIA_TYPES = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"] as const;
export const USER_ROLES = ["CUSTOMER", "MECHANIC", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const QUOTE_REQUEST_STATUSES = ["PENDING", "ACCEPTED", "DECLINED"] as const;
export type QuoteRequestStatus = (typeof QUOTE_REQUEST_STATUSES)[number];

export const ACCOUNT_PAYABLE_STATUSES = ["PENDING", "PAID", "OVERDUE", "CANCELLED"] as const;
export type AccountPayableStatus = (typeof ACCOUNT_PAYABLE_STATUSES)[number];

export const ACCOUNT_RECEIVABLE_STATUSES = ["PENDING", "RECEIVED", "OVERDUE", "CANCELLED"] as const;
export type AccountReceivableStatus = (typeof ACCOUNT_RECEIVABLE_STATUSES)[number];

export const INVOICE_TYPES = ["NFE", "NFSE", "NFCE"] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const INVOICE_STATUSES = ["DRAFT", "PENDING", "ISSUED", "CANCELLED", "ERROR"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PURCHASE_ORDER_STATUSES = ["DRAFT", "SENT", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const BAY_TYPES = ["BAY", "LIFT"] as const;
export type BayType = (typeof BAY_TYPES)[number];

export const COUNTER_SALE_STATUSES = ["COMPLETED", "CANCELLED"] as const;
export type CounterSaleStatus = (typeof COUNTER_SALE_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ["SMS", "WHATSAPP"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// Meses sem serviço a partir dos quais um veículo é sinalizado para revisão preventiva.
export const REVISION_ALERT_MONTHS = 6;

export const COMMISSION_STATUSES = ["PENDING", "PAID", "CANCELLED"] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const APPOINTMENT_STATUSES = [
  "SCHEDULED",
  "CONFIRMED",
  "IN_PROGRESS",
  "DONE",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

// --- Gaps SIGMA (fases 1-8) ---------------------------------------------

export const SERVICE_ORDER_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type ServiceOrderPriority = (typeof SERVICE_ORDER_PRIORITIES)[number];

export const APPROVAL_KINDS = ["INITIAL", "SUPPLEMENT"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const INVENTORY_PART_KINDS = ["PART", "MATERIAL"] as const;
export type InventoryPartKind = (typeof INVENTORY_PART_KINDS)[number];

export const ESTIMATE_STATUSES = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "PARTIALLY_APPROVED",
  "REJECTED",
  "SUPPLEMENT_REQUESTED",
  "CANCELLED",
  "CONVERTED",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const ESTIMATE_ITEM_CLASSIFICATIONS = ["REPAIR", "REPLACE", "REUSE", "PENDING"] as const;
export type EstimateItemClassification = (typeof ESTIMATE_ITEM_CLASSIFICATIONS)[number];

export const INSPECTION_STATUSES = [
  "TO_SCHEDULE",
  "SCHEDULED",
  "DONE",
  "RESCHEDULED",
  "CANCELLED",
  "ADJUSTMENT_PENDING",
] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const INSPECTION_ISSUE_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
export type InspectionIssueStatus = (typeof INSPECTION_ISSUE_STATUSES)[number];

export const TIME_ENTRY_STATUSES = ["RUNNING", "PAUSED", "DONE"] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  "STALE_STATUS",
  "SUPPLEMENT_PENDING",
  "LOW_STOCK",
  "INSPECTION_TODAY",
  "DELIVERY_TOMORROW",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// Nº de dias parado num mesmo status a partir do qual a OS entra no alerta "parada".
export const STALE_STATUS_ALERT_DAYS = 3;
// Nº de dias de complemento pendente a partir do qual entra no alerta.
export const SUPPLEMENT_PENDING_ALERT_DAYS = 2;
