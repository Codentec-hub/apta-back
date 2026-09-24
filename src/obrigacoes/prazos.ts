// Cálculo de prazos no modelo do Acessórias: cada obrigação define, para
// cada MÊS DE ENTREGA (Jan–Dez), um código de data; a competência sai de
// "Competências referentes a" e o prazo técnico de "Lembrar responsável
// quantos dias antes".
//
// Códigos (os mesmos valores do select do Acessórias):
//   0      não tem entrega neste mês
//   1–31   todo dia N (ajustado se cair em dia não útil)
//   51–70  1º a 20º dia útil
//   90     último dia útil
//
// Competências são guardadas como o dia 1 do mês (coluna DATE). Prazos são
// guardados como o fim do dia em Fortaleza (UTC-3, sem horário de verão),
// para que "vence hoje" só vire atraso depois das 23:59 locais.
import type { AjustePrazo, TipoDias, TipoObrigacao } from "@prisma/client";

const OFFSET_FORTALEZA_HORAS = 3;

export const CODIGO_NAO_TEM = 0;
export const CODIGO_ULTIMO_DIA_UTIL = 90;

export type DataCivil = { ano: number; mes: number; dia: number }; // mes 1–12

function chave({ ano, mes, dia }: DataCivil): string {
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function somarDias(data: DataCivil, dias: number): DataCivil {
  const d = new Date(Date.UTC(data.ano, data.mes - 1, data.dia + dias));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

function diaDaSemana(data: DataCivil): number {
  return new Date(Date.UTC(data.ano, data.mes - 1, data.dia)).getUTCDay();
}

function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher).
function pascoa(ano: number): DataCivil {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return { ano, mes, dia };
}

const cacheFeriados = new Map<number, Set<string>>();

// Feriados nacionais (fixos + móveis: Carnaval, Sexta-feira Santa, Corpus
// Christi — que na prática param a Receita). Estaduais/municipais ficam de
// fora: para esses, a alteração de prazos em massa resolve.
function feriadosNacionais(ano: number): Set<string> {
  const emCache = cacheFeriados.get(ano);
  if (emCache) return emCache;

  const fixos: [number, number][] = [
    [1, 1], [4, 21], [5, 1], [9, 7], [10, 12], [11, 2], [11, 15], [11, 20], [12, 25],
  ];
  const p = pascoa(ano);
  const moveis = [somarDias(p, -48), somarDias(p, -47), somarDias(p, -2), somarDias(p, 60)];

  const set = new Set<string>([...fixos.map(([mes, dia]) => chave({ ano, mes, dia })), ...moveis.map(chave)]);
  cacheFeriados.set(ano, set);
  return set;
}

export function ehDiaUtil(data: DataCivil, sabadoUtil = false): boolean {
  const dow = diaDaSemana(data);
  if (dow === 0 || (dow === 6 && !sabadoUtil)) return false;
  return !feriadosNacionais(data.ano).has(chave(data));
}

function ajustarParaDiaUtil(data: DataCivil, ajuste: AjustePrazo, sabadoUtil: boolean): DataCivil {
  if (ajuste === "MANTER") return data;
  const passo = ajuste === "ANTECIPAR" ? -1 : 1;
  let atual = data;
  while (!ehDiaUtil(atual, sabadoUtil)) atual = somarDias(atual, passo);
  return atual;
}

function nEsimoDiaUtil(ano: number, mes: number, n: number, sabadoUtil: boolean): DataCivil {
  let atual: DataCivil = { ano, mes, dia: 1 };
  let contados = ehDiaUtil(atual, sabadoUtil) ? 1 : 0;
  while (contados < n) {
    atual = somarDias(atual, 1);
    if (ehDiaUtil(atual, sabadoUtil)) contados += 1;
  }
  return atual;
}

function ultimoDiaUtil(ano: number, mes: number, sabadoUtil: boolean): DataCivil {
  let atual: DataCivil = { ano, mes, dia: ultimoDiaDoMes(ano, mes) };
  while (!ehDiaUtil(atual, sabadoUtil)) atual = somarDias(atual, -1);
  return atual;
}

type RegraPrazo = Pick<
  TipoObrigacao,
  "entregasPorMes" | "competenciaReferente" | "diasAntes" | "tipoDiasAntes" | "ajustePrazo" | "sabadoUtil"
>;

// Data do prazo legal para o mês de entrega, ou null se "Não tem".
export function dataDeEntrega(regra: RegraPrazo, ano: number, mes: number): DataCivil | null {
  const codigo = regra.entregasPorMes[mes - 1] ?? CODIGO_NAO_TEM;
  if (codigo === CODIGO_NAO_TEM) return null;
  if (codigo === CODIGO_ULTIMO_DIA_UTIL) return ultimoDiaUtil(ano, mes, regra.sabadoUtil);
  if (codigo > 50 && codigo <= 70) return nEsimoDiaUtil(ano, mes, codigo - 50, regra.sabadoUtil);
  const dia = Math.min(codigo, ultimoDiaDoMes(ano, mes));
  return ajustarParaDiaUtil({ ano, mes, dia }, regra.ajustePrazo, regra.sabadoUtil);
}

function voltarDias(data: DataCivil, dias: number, tipo: TipoDias, sabadoUtil: boolean): DataCivil {
  if (tipo === "CORRIDOS") {
    // Lembrete em fim de semana/feriado não faz sentido: antecipa.
    return ajustarParaDiaUtil(somarDias(data, -dias), "ANTECIPAR", sabadoUtil);
  }
  let atual = data;
  let restantes = dias;
  while (restantes > 0) {
    atual = somarDias(atual, -1);
    if (ehDiaUtil(atual, sabadoUtil)) restantes -= 1;
  }
  return atual;
}

export function fimDoDiaEmFortaleza(data: DataCivil): Date {
  return new Date(Date.UTC(data.ano, data.mes - 1, data.dia, 23 + OFFSET_FORTALEZA_HORAS, 59, 59));
}

// Competência da entrega de um mês: relativa em meses (-3…1) ou anual
// (-12 = ano anterior, 12 = ano atual). Competência anual é guardada como
// janeiro do ano e exibida só com o ano.
export function competenciaDaEntrega(ano: number, mes: number, referente: number): Date {
  if (referente === -12) return new Date(Date.UTC(ano - 1, 0, 1));
  if (referente === 12) return new Date(Date.UTC(ano, 0, 1));
  return new Date(Date.UTC(ano, mes - 1 + referente, 1));
}

export function calcularEntrega(
  regra: RegraPrazo,
  ano: number,
  mes: number
): { competencia: Date; prazo: Date; prazoTecnico: Date } | null {
  const legal = dataDeEntrega(regra, ano, mes);
  if (!legal) return null;
  const tecnico = regra.diasAntes > 0 ? voltarDias(legal, regra.diasAntes, regra.tipoDiasAntes, regra.sabadoUtil) : legal;
  return {
    competencia: competenciaDaEntrega(ano, mes, regra.competenciaReferente),
    prazo: fimDoDiaEmFortaleza(legal),
    prazoTecnico: fimDoDiaEmFortaleza(tecnico),
  };
}

// "2026-09" → Date(2026-09-01) para a coluna DATE.
export function competenciaParaDate(competencia: string): Date {
  const [ano, mes] = competencia.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, 1));
}

// Mês corrente em Fortaleza.
export function mesAtual(agora: Date = new Date()): { ano: number; mes: number } {
  const local = new Date(agora.getTime() - OFFSET_FORTALEZA_HORAS * 3600 * 1000);
  return { ano: local.getUTCFullYear(), mes: local.getUTCMonth() + 1 };
}

export function somarMeses(ano: number, mes: number, n: number): { ano: number; mes: number } {
  const d = new Date(Date.UTC(ano, mes - 1 + n, 1));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 };
}
