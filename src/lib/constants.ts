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

export const APPOINTMENT_STATUSES = [
  "SCHEDULED",
  "CONFIRMED",
  "IN_PROGRESS",
  "DONE",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
