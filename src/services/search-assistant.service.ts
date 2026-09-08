// Mesmo provider/modelo já usado em truck-vision.service.ts, vehicle-recognition.service.ts
// e invoice-ocr.service.ts — reaproveitado por consistência (só que aqui só texto, sem imagem).
const OPENAI_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

export class SearchAssistantError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface SearchAssistAction {
  path: string;
  label: string;
}

export interface SearchAssistResult {
  message: string;
  suggestedQuery: string | null;
  actions: SearchAssistAction[];
}

// Rotas que a IA pode sugerir — mesma lista de abas do painel (src/app/dashboard/layout.tsx
// no front). Qualquer path que a IA responda fora desta lista é descartado antes de
// devolver ao cliente, pra nunca navegar o usuário para algo inexistente/inválido.
const KNOWN_ROUTES: SearchAssistAction[] = [
  { path: "/dashboard", label: "Projetos" },
  { path: "/dashboard/solicitacoes", label: "Solicitações" },
  { path: "/dashboard/usuarios", label: "Usuários" },
  { path: "/dashboard/pecas", label: "Peças" },
  { path: "/dashboard/financeiro", label: "Financeiro" },
  { path: "/dashboard/clientes", label: "Clientes" },
  { path: "/dashboard/complementos", label: "Complementos" },
  { path: "/dashboard/alertas", label: "Alertas" },
  { path: "/dashboard/caminhoes", label: "Caminhões" },
  { path: "/dashboard/seguradoras", label: "Seguradoras" },
  { path: "/dashboard/fornecedores", label: "Fornecedores" },
  { path: "/dashboard/compras", label: "Compras" },
  { path: "/dashboard/agenda", label: "Agenda" },
  { path: "/dashboard/pdv", label: "PDV" },
  { path: "/dashboard/garantias", label: "Garantias" },
  { path: "/dashboard/relatorios", label: "Relatórios" },
  { path: "/dashboard/comissoes", label: "Comissões" },
  { path: "/dashboard/lojas", label: "Lojas" },
  { path: "/dashboard/cargos", label: "Cargos" },
  { path: "/dashboard/perfil", label: "Perfil" },
];

const SYSTEM_PROMPT = `Você é o assistente da BOX., um sistema de gestão de oficina mecânica. Um funcionário digitou um termo na busca global do sistema e ela não encontrou nada (a busca cobre: ordens de serviço, orçamentos, usuários/clientes, veículos, fornecedores, peças de estoque, caminhões e seguradoras).

Seu trabalho é ajudar essa pessoa. Responda SEMPRE em português, APENAS com um JSON válido, sem markdown, no formato:
{
  "message": "<1-2 frases curtas explicando por que talvez não tenha achado nada e/ou o que a pessoa pode fazer>",
  "suggestedQuery": "<um termo de busca alternativo mais provável de achar algo, ou null se não houver sugestão melhor>",
  "actions": [{ "path": "<uma das rotas da lista abaixo>", "label": "<label EXATAMENTE como está na lista>" }]
}

"actions" deve ter no máximo 2 itens, só rotas realmente relevantes pro que a pessoa parece estar procurando — nunca invente uma rota fora da lista. Se nada for claramente relevante, devolva "actions": [].

Rotas disponíveis (path — label — o que tem lá):
- /dashboard — Projetos — kanban das ordens de serviço em andamento
- /dashboard/solicitacoes — Solicitações — pedidos de orçamento feitos por clientes, aguardando aceite
- /dashboard/usuarios — Usuários — cadastro de usuários do sistema (clientes, mecânicos, admins)
- /dashboard/clientes — Clientes — cadastro de clientes e veículos deles
- /dashboard/pecas — Peças — estoque de peças e materiais, compras
- /dashboard/fornecedores — Fornecedores — cadastro de fornecedores de peças
- /dashboard/compras — Compras — pedidos de compra a fornecedores
- /dashboard/financeiro — Financeiro — contas a pagar/receber, fluxo de caixa, faturas
- /dashboard/comissoes — Comissões — comissão dos mecânicos sobre reparos
- /dashboard/caminhoes — Caminhões — frota, pilotagens e abastecimentos
- /dashboard/seguradoras — Seguradoras — cadastro de seguradoras parceiras
- /dashboard/agenda — Agenda — agendamentos de horário/baia
- /dashboard/pdv — PDV — venda de balcão (peças direto, sem OS)
- /dashboard/garantias — Garantias — peças com garantia vencendo ou vencida
- /dashboard/relatorios — Relatórios — indicadores e relatórios gerenciais
- /dashboard/lojas — Lojas — unidades/lojas cadastradas
- /dashboard/cargos — Cargos — cargos e permissões de acesso
- /dashboard/complementos — Complementos — pendências/complementos de orçamento
- /dashboard/alertas — Alertas — notificações do sistema
- /dashboard/perfil — Perfil — dados da própria conta

Seja direto e útil, como alguém que conhece bem o sistema orientando um colega.`;

export async function getSearchAssistance(query: string): Promise<SearchAssistResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new SearchAssistantError("Assistente de IA não configurado (defina OPENAI_API_KEY no ambiente).", 501);
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Termo buscado, sem resultados: "${query}"` },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new SearchAssistantError(`Falha ao consultar a IA (${res.status}): ${errBody.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new SearchAssistantError("A IA não retornou uma resposta legível.", 502);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new SearchAssistantError("A IA retornou um formato inesperado.", 502);
  }

  const message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : "Não encontramos nada para esse termo.";
  const suggestedQueryRaw = typeof parsed.suggestedQuery === "string" ? parsed.suggestedQuery.trim() : "";
  const suggestedQuery = suggestedQueryRaw && suggestedQueryRaw.toLowerCase() !== query.trim().toLowerCase() ? suggestedQueryRaw : null;

  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: SearchAssistAction[] = [];
  for (const item of rawActions) {
    if (!item || typeof item !== "object") continue;
    const path = (item as Record<string, unknown>).path;
    const known = KNOWN_ROUTES.find((r) => r.path === path);
    if (known && !actions.some((a) => a.path === known.path)) actions.push(known);
    if (actions.length >= 2) break;
  }

  return { message, suggestedQuery, actions };
}
