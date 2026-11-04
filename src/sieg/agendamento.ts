// Busca agendada da SIEG (mesmo padrão de alerta-nao-lida.ts: setInterval
// de hora em hora).
//  - Toda hora: renova o token OAuth se faltar menos de 7 dias (Fase C).
//  - Uma vez por noite (a partir das 2h, horário de Brasília): atualiza a
//    lista de empresas, o status dos certificados e conta as notas do mês
//    atual e do anterior. Com os limites da SIEG (contar = 5/min), 60
//    empresas × 2 meses × 2 papéis levam ~50 minutos -- por isso de noite.
import { prisma } from "../prisma.js";
import { credenciaisConfiguradas } from "./auth.js";
import { limparRegistroChamadas } from "./cliente.js";
import { sincronizarEmpresas } from "./empresas.js";
import { atualizarStatusCertificado, contarNotasTodas, encerrarBuscasOrfas, mesesRecentes } from "./notas.js";
import { renovarTokenSeNecessario } from "./oauth.js";

const HORA_INICIO_NOITE = 2; // 2h em Brasília
const INTERVALO_MINIMO_MS = 20 * 3_600_000;

let rodando = false;
let ultimaVerificacao: string | null = null;
let ultimaAcao: string | null = null;

export function estadoAgendamento() {
  return { rodando, ultimaVerificacao, ultimaAcao, horario: `diariamente a partir das ${HORA_INICIO_NOITE}h` };
}

const horaBrasilia = () => Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }));

async function tokenAutorizado(): Promise<boolean> {
  const c = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  return Boolean(c?.oauthToken && c.oauthExpiraEm && c.oauthExpiraEm > new Date());
}

/** Busca completa (empresas + status + contagens). Também usada pelo botão "rodar agora". */
export async function sincronizacaoCompleta(): Promise<void> {
  if (rodando) return;
  rodando = true;
  const erros: string[] = [];
  try {
    try {
      await sincronizarEmpresas();
    } catch (error) {
      erros.push(`empresas: ${error instanceof Error ? error.message : String(error)}`);
    }
    const ativas = await prisma.siegEmpresa.findMany({ where: { ativo: true, deletado: false }, select: { id: true } });
    for (const e of ativas) {
      try {
        await atualizarStatusCertificado(e.id);
      } catch {
        // status é informativo; segue para a próxima
      }
    }
    for (const mes of mesesRecentes(2)) {
      try {
        await contarNotasTodas(mes);
      } catch (error) {
        erros.push(`contagem ${mes}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await limparRegistroChamadas();
  } finally {
    rodando = false;
    await prisma.configuracaoSieg.update({
      where: { id: 1 },
      data: { ultimaSincronizacaoEm: new Date(), ultimaSincronizacaoErro: erros.length ? erros.join(" | ").slice(0, 1000) : null },
    });
    ultimaAcao = `busca completa ${erros.length ? "com erros" : "ok"} em ${new Date().toISOString()}`;
  }
}

async function verificar(): Promise<void> {
  ultimaVerificacao = new Date().toISOString();
  if (!(await credenciaisConfiguradas()) || !(await tokenAutorizado())) return;
  try {
    if (await renovarTokenSeNecessario()) ultimaAcao = `token renovado em ${new Date().toISOString()}`;
  } catch (error) {
    console.error("[sieg] falha ao renovar o token OAuth", error);
  }
  if (horaBrasilia() < HORA_INICIO_NOITE || horaBrasilia() >= 6) return;
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  const ultima = config?.ultimaSincronizacaoEm?.getTime() ?? 0;
  if (Date.now() - ultima < INTERVALO_MINIMO_MS) return;
  await sincronizacaoCompleta();
}

export function agendarSieg(): void {
  void encerrarBuscasOrfas().catch(() => {});
  const rodar = () => {
    verificar().catch((erro) => console.error("[sieg] falha na busca agendada", erro));
  };
  rodar();
  setInterval(rodar, 60 * 60 * 1000).unref();
}
