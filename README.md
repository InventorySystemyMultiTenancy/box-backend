# BOX. — Backend

API + realtime da plataforma de acompanhamento de manutenção. Implementa o domínio descrito em
`especificacao-experiencia-digital.html`: autenticação, veículos, ordens de serviço, timeline,
peças/componentes, aprovações digitais, chat e upload de mídia — com push em tempo real via Socket.io.

Deploy alvo: **Render**.

## Stack

- Node.js + TypeScript + Express 5
- Prisma ORM — Postgres em desenvolvimento e produção
- Socket.io para eventos em tempo real (timeline, status, peças, aprovações, chat)
- JWT (jsonwebtoken + bcryptjs) para autenticação, com cargos (Role) e permissões granulares
- Multer para upload de fotos/vídeos/áudios

## Como rodar localmente

Requer um banco Postgres acessível (local, Docker ou um banco de dev na nuvem como Neon/Render/Supabase).

```bash
npm install
cp .env.example .env      # edite DATABASE_URL com a connection string do seu Postgres
npm run prisma:migrate    # aplica o schema
npm run seed               # popula um cenário de demonstração completo (cargos, permissões, clientes)
npm run dev                 # sobe em http://localhost:4000
```

Contas criadas pelo seed:

| Papel     | E-mail             | Senha        |
|-----------|--------------------|--------------|
| Cliente   | cliente@box.demo   | cliente123   |
| Mecânico  | diego@box.demo     | mecanico123  |
| Admin     | admin@box.demo     | admin123     |

## Scripts

- `npm run dev` — servidor com reload automático
- `npm run build` / `npm start` — build de produção e execução
- `npm run prisma:migrate` — cria/atualiza o schema do banco
- `npm run prisma:studio` — inspeciona os dados em uma UI
- `npm run seed` — repopula os dados de demonstração

## Deploy (Render)

1. Crie um banco Postgres no Render (ou Neon) e copie a connection string.
2. Defina `DATABASE_URL` no ambiente do Render com a connection string.
3. Rode `npx prisma migrate deploy` no primeiro deploy.

## Estrutura

```
src/
  app.ts              # montagem do Express e das rotas
  server.ts           # HTTP server + bootstrap do Socket.io
  lib/                # prisma client, jwt, constantes de domínio, autorização, paginação
  middleware/          # auth (JWT + role legado), permissions (cargo + permissão granular), upload (multer)
  services/             # regra de negócio dos módulos novos (clients, roles/permissions) — módulos
                          # mais antigos ainda têm a lógica direto nas rotas, migração é gradual
  routes/              # auth, vehicles, service-orders, timeline, parts, approvals, chat, uploads,
                          # quote-requests, inventory-parts, finance, bank-accounts, accounts-payable,
                          # accounts-receivable, invoices (fiscal), suppliers, purchase-orders,
                          # bays, appointments (agenda), clients, roles
  sockets/              # gateway Socket.io (join-order, emitToOrder)
prisma/
  schema.prisma
  seed.ts
```

## Modelo de dados (visão geral)

`User` → `Vehicle` → `ServiceOrder` → (`TimelineEvent`, `VehiclePart`, `Approval`, `Media`, `ChatMessage`)

Os 11 status de `ServiceOrder` e os status de `VehiclePart` estão centralizados em
`src/lib/constants.ts` — é a fonte da verdade que o frontend espelha.

## Financeiro e fiscal

Além dos lançamentos simples (`FinancialEntry`, gerados automaticamente a partir de peças/aprovações),
o backend tem um módulo de gestão financeira completo:

- **Contas bancárias** (`/api/finance/bank-accounts`) — saldo calculado a partir do saldo inicial +
  recebido - pago.
- **Contas a pagar/receber** (`/api/finance/payables`, `/api/finance/receivables`) — com parcelamento
  (`installments`), baixa (`/pay`, `/receive`) e cancelamento. `/api/finance/receivables/from-service-order`
  gera uma cobrança a partir do total já aprovado numa OS.
- **Fluxo de caixa e DRE** (`/api/finance/cash-flow`, `/api/finance/dre`) — agregados por período
  (`?from=&to=`) a partir do que já foi efetivamente pago/recebido.
- **Notas fiscais** (`/api/invoices`) — NF-e/NFS-e/NFC-e como rascunho → emitida → cancelada. A emissão
  passa por um `NFeProvider` (`src/services/fiscal/nfe-provider.ts`); em dev usa `MockNFeProvider`
  (gera número sequencial local, sem SEFAZ/prefeitura). Trocar por um gateway real (eNotas, Focus NFe...)
  é implementar essa mesma interface — vai precisar de certificado digital e contrato com o gateway.

Todas as rotas novas exigem permissão granular (`finance.view`/`finance.manage`,
`invoices.view`/`invoices.manage`), não o `role` legado.

## Compras e fornecedores

- **Fornecedores** (`/api/suppliers`) — cadastro simples (permissões `suppliers.view`/`suppliers.manage`).
- **Pedidos de compra** (`/api/purchase-orders`) — `DRAFT → SENT → PARTIALLY_RECEIVED/RECEIVED → CANCELLED`.
  Enviar um pedido (`/:id/send`) gera automaticamente uma `AccountPayable` no valor total dos itens.
  Receber (`/:id/receive`, parcial ou total) dá entrada no estoque (`InventoryPart.stockQty`).
- **Reposição por ponto mínimo** — `InventoryPart` tem `minStockQty`/`reorderQty`/`preferredSupplierId`.
  `GET /api/purchase-orders/replenishment-suggestions` lista peças no ponto mínimo ou abaixo com a
  quantidade sugerida; `POST /api/purchase-orders/from-suggestions` gera um rascunho de pedido por
  fornecedor preferencial automaticamente.

## Agenda

- **Boxes/elevadores** (`/api/agenda/bays`) — cadastro simples (`agenda.view`/`agenda.manage`).
- **Agendamentos** (`/api/agenda/appointments`) — calendário visual (`?from=&to=&mechanicId=&bayId=`),
  com checagem de conflito de horário por mecânico e por box/elevador na criação/edição.
  Camada desacoplada do `ServiceOrder.status`/`scheduledAt` — pode referenciar uma OS existente
  (`serviceOrderId`) ou ser um agendamento avulso.
- **Carga de trabalho por mecânico** — `GET /api/agenda/appointments/workload?from=&to=`.
- **Ocupação de box/elevador** — `GET /api/agenda/appointments/bay-occupancy?from=&to=`.

## Tempo real

O cliente conecta ao Socket.io e emite `join-order` com `{ orderId, token }`. O servidor valida o
token e a posse do veículo antes de inscrever o socket na sala `order:<id>`. Eventos emitidos:
`status:update`, `timeline:new`, `part:update`, `approval:new`, `approval:update`, `chat:message`,
`media:new`.
