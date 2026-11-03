import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http-error";

// Relatório de abastecimentos (Caminhões > Abastecimentos > "Relatório"): gasto, litros,
// km rodados e consumo por caminhão e por motorista, dias e dias da semana com mais
// abastecimento e os pontos de atenção do período. As contas ficam em
// buildRefuelingReport (pura, testada); o frontend só monta o PDF.
//
// Km rodados: de um abastecimento ao outro do MESMO caminhão (km atual − km do abastecimento
// anterior, mesmo que este tenha sido antes do período). Sem abastecimento anterior, vale o
// km de referência gravado (início da pilotagem). Consumo = km rodados ÷ litros abastecidos.

const DAY_MS = 24 * 60 * 60 * 1000;
// Brasília (UTC−3, sem horário de verão): dia começa às 03:00 UTC.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export interface RefuelingRow {
  id: string;
  createdAt: Date;
  truckId: string;
  truck: { plate: string; brand: string | null; model: string | null };
  driverId: string;
  driver: { name: string };
  currentKm: number;
  referenceKm: number;
  liters: number;
  amountPaid: number;
  pricePerLiter: number | null;
}

export interface RefuelingReportPeriod {
  from: string; // YYYY-MM-DD (Brasília)
  to: string;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number, digits = 2) {
  return denominator > 0 ? round(numerator / denominator, digits) : null;
}

/** Dia (YYYY-MM-DD) no horário de Brasília. */
export function brtDay(date: Date) {
  return new Date(date.getTime() - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Período escolhido (dias de Brasília) → intervalo [início, fim) em UTC. */
export function periodRange({ from, to }: RefuelingReportPeriod) {
  const parse = (value: string) => {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new HttpError(400, "Período inválido.");
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + BRT_OFFSET_MS;
  };
  const start = parse(from);
  const end = parse(to) + DAY_MS;
  if (end <= start) throw new HttpError(400, "A data final precisa ser igual ou depois da inicial.");
  return { start: new Date(start), end: new Date(end), days: Math.round((end - start) / DAY_MS) };
}

type Entry = {
  id: string;
  date: string; // ISO
  day: string;
  truckId: string;
  plate: string;
  driverId: string;
  driver: string;
  currentKm: number;
  kmSincePrevious: number | null;
  liters: number;
  amount: number;
  pricePerLiter: number;
  kmPerLiter: number | null;
};

type Bucket = { refuelings: number; liters: number; amount: number; km: number; kmLiters: number; kmAmount: number };

const emptyBucket = (): Bucket => ({ refuelings: 0, liters: 0, amount: 0, km: 0, kmLiters: 0, kmAmount: 0 });

function add(bucket: Bucket, entry: Entry) {
  bucket.refuelings += 1;
  bucket.liters += entry.liters;
  bucket.amount += entry.amount;
  // Consumo e custo por km só com os abastecimentos que têm km rodado conhecido.
  if (entry.kmSincePrevious != null) {
    bucket.km += entry.kmSincePrevious;
    bucket.kmLiters += entry.liters;
    bucket.kmAmount += entry.amount;
  }
}

/**
 * `rows`: abastecimentos do período; `previousKmByTruck`: km do último abastecimento de cada
 * caminhão ANTES do período (para o km rodado do primeiro abastecimento do período).
 */
export function buildRefuelingReport(rows: RefuelingRow[], previousKmByTruck: Map<string, number>, period: RefuelingReportPeriod) {
  const { days: periodDays } = periodRange(period);
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const lastKm = new Map(previousKmByTruck);
  const alerts: { date: string; plate: string; driver: string; message: string }[] = [];
  const entries: Entry[] = sorted.map((row) => {
    const amount = Number(row.amountPaid);
    const pricePerLiter = row.pricePerLiter != null ? Number(row.pricePerLiter) : row.liters > 0 ? amount / row.liters : 0;
    const previousKm = lastKm.get(row.truckId) ?? row.referenceKm;
    const diff = row.currentKm - previousKm;
    if (diff < 0) {
      alerts.push({
        date: row.createdAt.toISOString(),
        plate: row.truck.plate,
        driver: row.driver.name,
        message: `Km informado (${row.currentKm.toLocaleString("pt-BR")}) menor que o do abastecimento anterior (${previousKm.toLocaleString("pt-BR")}) — conferir a leitura do painel.`,
      });
    }
    lastKm.set(row.truckId, Math.max(previousKm, row.currentKm));
    const kmSincePrevious = diff > 0 ? diff : null;
    return {
      id: row.id,
      date: row.createdAt.toISOString(),
      day: brtDay(row.createdAt),
      truckId: row.truckId,
      plate: row.truck.plate,
      driverId: row.driverId,
      driver: row.driver.name,
      currentKm: row.currentKm,
      kmSincePrevious,
      liters: round(row.liters),
      amount: round(amount),
      pricePerLiter: round(pricePerLiter, 3),
      kmPerLiter: kmSincePrevious != null && row.liters > 0 ? round(kmSincePrevious / row.liters) : null,
    };
  });

  const totals = emptyBucket();
  const trucks = new Map<string, Bucket & { plate: string; label: string; drivers: Map<string, number>; kmPerLiter: number[]; firstKm: number; lastKm: number; prices: number[] }>();
  const drivers = new Map<string, Bucket & { name: string; trucks: Set<string> }>();
  const days = new Map<string, Bucket>();
  const weekdays = WEEKDAYS.map(() => emptyBucket());

  const rowsById = new Map(sorted.map((r) => [r.id, r]));
  for (const entry of entries) {
    const row = rowsById.get(entry.id)!;
    add(totals, entry);

    let truck = trucks.get(entry.truckId);
    if (!truck) {
      const label = [row.truck.brand, row.truck.model].filter(Boolean).join(" ");
      truck = { ...emptyBucket(), plate: entry.plate, label, drivers: new Map(), kmPerLiter: [], firstKm: entry.currentKm, lastKm: entry.currentKm, prices: [] };
      trucks.set(entry.truckId, truck);
    }
    add(truck, entry);
    truck.drivers.set(entry.driver, (truck.drivers.get(entry.driver) ?? 0) + 1);
    if (entry.kmPerLiter != null) truck.kmPerLiter.push(entry.kmPerLiter);
    truck.prices.push(entry.pricePerLiter);
    truck.lastKm = Math.max(truck.lastKm, entry.currentKm);

    let driver = drivers.get(entry.driverId);
    if (!driver) {
      driver = { ...emptyBucket(), name: entry.driver, trucks: new Set() };
      drivers.set(entry.driverId, driver);
    }
    add(driver, entry);
    driver.trucks.add(entry.plate);

    if (!days.has(entry.day)) days.set(entry.day, emptyBucket());
    add(days.get(entry.day)!, entry);
    add(weekdays[new Date(`${entry.day}T12:00:00Z`).getUTCDay()], entry);
  }

  const fleetAvgPrice = ratio(totals.amount, totals.liters, 3);

  // Pontos de atenção: consumo bem pior que a média do próprio caminhão no período (com pelo
  // menos 3 medições) e preço por litro bem acima da média da frota.
  for (const entry of entries) {
    const truck = trucks.get(entry.truckId)!;
    const truckAvg = ratio(truck.km, truck.kmLiters);
    if (entry.kmPerLiter != null && truckAvg && truck.kmPerLiter.length >= 3 && entry.kmPerLiter < truckAvg * 0.75) {
      alerts.push({
        date: entry.date,
        plate: entry.plate,
        driver: entry.driver,
        message: `Consumo de ${entry.kmPerLiter.toFixed(2)} km/l, bem abaixo da média do caminhão no período (${truckAvg.toFixed(2)} km/l).`,
      });
    }
    if (fleetAvgPrice && entry.pricePerLiter > fleetAvgPrice * 1.1) {
      alerts.push({
        date: entry.date,
        plate: entry.plate,
        driver: entry.driver,
        message: `Preço de R$ ${entry.pricePerLiter.toFixed(3)}/L, acima da média da frota no período (R$ ${fleetAvgPrice.toFixed(3)}/L).`,
      });
    }
  }
  alerts.sort((a, b) => a.date.localeCompare(b.date));

  const share = (amount: number) => (totals.amount > 0 ? round((amount / totals.amount) * 100, 1) : 0);
  const summary = (b: Bucket) => ({
    refuelings: b.refuelings,
    liters: round(b.liters),
    amount: round(b.amount),
    km: b.km,
    avgKmPerLiter: ratio(b.km, b.kmLiters),
    costPerKm: ratio(b.kmAmount, b.km, 3),
    avgPricePerLiter: ratio(b.amount, b.liters, 3),
    avgAmountPerRefueling: ratio(b.amount, b.refuelings),
    sharePct: share(b.amount),
  });

  const dayList = [...days.entries()].map(([date, b]) => ({ date, ...summary(b) })).sort((a, b) => a.date.localeCompare(b.date));
  const cheapest = entries.length ? entries.reduce((best, e) => (e.pricePerLiter < best.pricePerLiter ? e : best)) : null;
  const priciest = entries.length ? entries.reduce((best, e) => (e.pricePerLiter > best.pricePerLiter ? e : best)) : null;

  return {
    period: { ...period, days: periodDays },
    totals: {
      ...summary(totals),
      trucks: trucks.size,
      drivers: drivers.size,
      daysWithRefueling: days.size,
      avgAmountPerDay: round(totals.amount / periodDays),
      avgLitersPerRefueling: ratio(totals.liters, totals.refuelings),
      cheapest: cheapest && { date: cheapest.date, plate: cheapest.plate, pricePerLiter: cheapest.pricePerLiter },
      priciest: priciest && { date: priciest.date, plate: priciest.plate, pricePerLiter: priciest.pricePerLiter },
    },
    trucks: [...trucks.entries()]
      .map(([truckId, t]) => {
        const topDriver = [...t.drivers.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          truckId,
          plate: t.plate,
          label: t.label,
          ...summary(t),
          avgKmBetweenRefuelings: t.kmPerLiter.length ? Math.round(t.km / t.kmPerLiter.length) : null,
          bestKmPerLiter: t.kmPerLiter.length ? Math.max(...t.kmPerLiter) : null,
          worstKmPerLiter: t.kmPerLiter.length ? Math.min(...t.kmPerLiter) : null,
          minPricePerLiter: Math.min(...t.prices),
          maxPricePerLiter: Math.max(...t.prices),
          firstKm: t.firstKm,
          lastKm: t.lastKm,
          drivers: t.drivers.size,
          topDriver: topDriver ? { name: topDriver[0], refuelings: topDriver[1] } : null,
        };
      })
      .sort((a, b) => b.amount - a.amount),
    drivers: [...drivers.entries()]
      .map(([driverId, d]) => ({ driverId, name: d.name, ...summary(d), trucks: [...d.trucks].sort() }))
      .sort((a, b) => b.refuelings - a.refuelings || b.amount - a.amount),
    days: dayList,
    topDays: [...dayList].sort((a, b) => b.amount - a.amount || b.refuelings - a.refuelings).slice(0, 5),
    weekdays: weekdays.map((b, i) => ({ weekday: i, label: WEEKDAYS[i], ...summary(b) })),
    alerts,
    entries,
  };
}

export type RefuelingReport = ReturnType<typeof buildRefuelingReport>;

export async function getRefuelingReport(period: RefuelingReportPeriod & { truckId?: string }) {
  const { start, end } = periodRange(period);
  const truckFilter = period.truckId ? { truckId: period.truckId } : {};
  const rows = await prisma.truckRefueling.findMany({
    where: { ...truckFilter, createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      truckId: true,
      truck: { select: { plate: true, brand: true, model: true } },
      driverId: true,
      driver: { select: { name: true } },
      currentKm: true,
      referenceKm: true,
      liters: true,
      amountPaid: true,
      pricePerLiter: true,
    },
  });

  // Km do último abastecimento de cada caminhão antes do período (um por caminhão).
  const truckIds = [...new Set(rows.map((r) => r.truckId))];
  const previous = truckIds.length
    ? await prisma.truckRefueling.findMany({
        where: { truckId: { in: truckIds }, createdAt: { lt: start } },
        orderBy: { createdAt: "desc" },
        distinct: ["truckId"],
        select: { truckId: true, currentKm: true },
      })
    : [];

  return buildRefuelingReport(
    rows.map((r) => ({ ...r, amountPaid: Number(r.amountPaid), pricePerLiter: r.pricePerLiter != null ? Number(r.pricePerLiter) : null })),
    new Map(previous.map((p) => [p.truckId, p.currentKm])),
    period
  );
}
