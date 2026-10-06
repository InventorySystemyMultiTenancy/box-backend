import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";
import { nextPurchaseOrderCode } from "@/lib/purchase-order-code";

export class PurchaseOrderError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface PurchaseOrderItemInput {
  inventoryPartId: string;
  quantity: number;
  unitCost: number;
}

export interface PurchaseOrderInput {
  supplierId: string;
  storeId?: string;
  expectedDate?: string;
  notes?: string;
  items: PurchaseOrderItemInput[];
}

export async function listPurchaseOrders(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = typeof query.status === "string" ? query.status : undefined;
  const supplierId = typeof query.supplierId === "string" ? query.supplierId : undefined;
  const storeId = typeof query.storeId === "string" ? query.storeId : undefined;

  const where = {
    ...(status ? { status } : {}),
    ...(supplierId ? { supplierId } : {}),
    ...(storeId ? { storeId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: true, items: { include: { inventoryPart: true } } },
      orderBy: { createdAt: "desc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function getPurchaseOrderDetail(id: string) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, items: { include: { inventoryPart: true } }, payables: true },
  });
  if (!order) throw new PurchaseOrderError("Pedido de compra não encontrado.", 404);
  return order;
}

export async function createPurchaseOrder(input: PurchaseOrderInput) {
  if (input.items.length === 0) throw new PurchaseOrderError("Informe ao menos um item.", 400);

  const code = await nextPurchaseOrderCode();
  return prisma.purchaseOrder.create({
    data: {
      code,
      supplierId: input.supplierId,
      storeId: input.storeId,
      expectedDate: input.expectedDate ? new Date(input.expectedDate) : undefined,
      notes: input.notes,
      items: { create: input.items },
    },
    include: { supplier: true, items: { include: { inventoryPart: true } } },
  });
}

// Envia o pedido ao fornecedor: trava o rascunho e gera automaticamente a conta a
// pagar correspondente (total dos itens), como acontece numa compra real.
export async function sendPurchaseOrder(id: string) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, items: true },
  });
  if (!order) throw new PurchaseOrderError("Pedido de compra não encontrado.", 404);
  if (order.status !== "DRAFT") throw new PurchaseOrderError("Só é possível enviar um pedido em rascunho.", 409);

  const total = order.items.reduce((sum, item) => sum + item.unitCost * item.quantity, 0);
  const dueDate = order.expectedDate ?? defaultDueDate();

  return prisma.$transaction(async (tx) => {
    await tx.accountPayable.create({
      data: {
        description: `Pedido de compra ${order.code} — ${order.supplier.name}`,
        category: "FORNECEDOR",
        payeeName: order.supplier.name,
        amount: total,
        dueDate,
        purchaseOrderId: order.id,
        supplierId: order.supplierId,
      },
    });
    return tx.purchaseOrder.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date() },
      include: { supplier: true, items: { include: { inventoryPart: true } } },
    });
  });
}

export interface ReceiveItemInput {
  itemId: string;
  receivedQty: number;
}

// Registra o recebimento (total ou parcial) dos itens e recalcula o status do pedido.
// Não há estoque — só acompanha o que o fornecedor já entregou.
export async function receivePurchaseOrder(id: string, receipts: ReceiveItemInput[]) {
  const order = await prisma.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
  if (!order) throw new PurchaseOrderError("Pedido de compra não encontrado.", 404);
  if (order.status === "CANCELLED") throw new PurchaseOrderError("Este pedido foi cancelado.", 409);
  if (order.status === "RECEIVED") throw new PurchaseOrderError("Este pedido já foi totalmente recebido.", 409);

  return prisma.$transaction(async (tx) => {
    for (const receipt of receipts) {
      const item = order.items.find((i) => i.id === receipt.itemId);
      if (!item) throw new PurchaseOrderError(`Item ${receipt.itemId} não pertence a este pedido.`, 400);
      const remaining = item.quantity - item.receivedQty;
      if (receipt.receivedQty <= 0 || receipt.receivedQty > remaining) {
        throw new PurchaseOrderError(`Quantidade inválida para o item ${item.id} (restam ${remaining}).`, 400);
      }
      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: { receivedQty: { increment: receipt.receivedQty } },
      });
    }

    const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
    const allReceived = items.every((i) => i.receivedQty >= i.quantity);
    const anyReceived = items.some((i) => i.receivedQty > 0);

    return tx.purchaseOrder.update({
      where: { id },
      data: { status: allReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : order.status },
      include: { supplier: true, items: { include: { inventoryPart: true } } },
    });
  });
}

export async function cancelPurchaseOrder(id: string) {
  const order = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!order) throw new PurchaseOrderError("Pedido de compra não encontrado.", 404);
  if (order.status === "RECEIVED") throw new PurchaseOrderError("Não é possível cancelar um pedido já recebido.", 409);
  return prisma.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });
}

function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d;
}
