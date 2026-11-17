// Horário de Fortaleza (= Brasília, UTC-3, sem horário de verão).
export const FUSO = "America/Fortaleza";
const OFFSET_MS = 3 * 3_600_000;
export const MIN_MS = 60_000;
export const HORA_MS = 3_600_000;
export const DIA_MS = 86_400_000;

/** "2026-11-18" do instante, no fuso local. */
export const diaLocal = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: FUSO });

/** Instante de "AAAA-MM-DD" + "HH:MM" no horário local. */
export function instanteLocal(dia: string, hhmm: string): Date {
  return new Date(Date.parse(`${dia}T${hhmm}:00Z`) + OFFSET_MS);
}

/** Minutos desde a meia-noite local. */
export function minutosLocais(d: Date): number {
  const local = new Date(d.getTime() - OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

export function diaSemanaLocal(d: Date): number {
  return new Date(d.getTime() - OFFSET_MS).getUTCDay();
}

export function paraMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function somarDiasLocal(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
}

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "quarta, 19/11 às 09:30" */
export function rotuloHorario(d: Date): string {
  const dia = diaLocal(d);
  return `${DIAS[diaSemanaLocal(d)]}, ${dia.slice(8, 10)}/${dia.slice(5, 7)} às ${hhmm(minutosLocais(d))}`;
}

/** "quarta-feira, 19 de novembro, às 09:30" para mensagens ao lead. */
export function dataPorExtenso(d: Date): string {
  const data = d.toLocaleDateString("pt-BR", { timeZone: FUSO, weekday: "long", day: "numeric", month: "long" });
  return `${data}, às ${hhmm(minutosLocais(d))}`;
}

/** Agora, por extenso, para o assistente saber "hoje" e "amanhã". */
export function agoraPorExtenso(agora = new Date()): string {
  const data = agora.toLocaleDateString("pt-BR", { timeZone: FUSO, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return `${data}, ${hhmm(minutosLocais(agora))} (horário de Brasília), data ISO ${diaLocal(agora)}`;
}
