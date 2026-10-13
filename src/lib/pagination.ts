export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function parsePageParams(query: Record<string, unknown>): PageParams {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize) || DEFAULT_PAGE_SIZE));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Pagina uma lista formada por dois blocos em sequência (ex.: contas em aberto primeiro,
 * depois as quitadas/canceladas), repartindo skip/take entre as duas consultas.
 */
export async function pageAcrossSegments<T>(
  { skip, take }: PageParams,
  first: { count: () => Promise<number>; find: (skip: number, take: number) => Promise<T[]> },
  second: { count: () => Promise<number>; find: (skip: number, take: number) => Promise<T[]> }
) {
  const [firstTotal, secondTotal] = await Promise.all([first.count(), second.count()]);
  const firstTake = Math.max(0, Math.min(take, firstTotal - skip));
  const secondSkip = Math.max(0, skip - firstTotal);
  const secondTake = take - firstTake;
  const [firstItems, secondItems] = await Promise.all([
    firstTake > 0 ? first.find(skip, firstTake) : Promise.resolve([] as T[]),
    secondTake > 0 ? second.find(secondSkip, secondTake) : Promise.resolve([] as T[]),
  ]);
  return { items: [...firstItems, ...secondItems], total: firstTotal + secondTotal };
}

export function paginated<T>(items: T[], total: number, { page, pageSize }: PageParams) {
  return {
    items,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}
