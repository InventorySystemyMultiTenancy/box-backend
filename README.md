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
                          # quote-requests, inventory-parts, finance, clients, roles
  sockets/              # gateway Socket.io (join-order, emitToOrder)
prisma/
  schema.prisma
  seed.ts
```

## Modelo de dados (visão geral)

`User` → `Vehicle` → `ServiceOrder` → (`TimelineEvent`, `VehiclePart`, `Approval`, `Media`, `ChatMessage`)

Os 11 status de `ServiceOrder` e os status de `VehiclePart` estão centralizados em
`src/lib/constants.ts` — é a fonte da verdade que o frontend espelha.

## Tempo real

O cliente conecta ao Socket.io e emite `join-order` com `{ orderId, token }`. O servidor valida o
token e a posse do veículo antes de inscrever o socket na sala `order:<id>`. Eventos emitidos:
`status:update`, `timeline:new`, `part:update`, `approval:new`, `approval:update`, `chat:message`,
`media:new`.
