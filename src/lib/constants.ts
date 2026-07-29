// Mesma taxonomia de status usada no dashboard (frontendmecanic) e descrita
// na especificação de experiência — mudar aqui exige espelhar no frontend.

export const SERVICE_ORDER_STATUSES = [
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
