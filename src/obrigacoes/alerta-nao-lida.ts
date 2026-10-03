// Lembrete de guia não lida (modelo Acessórias): para os tipos de obrigação
// com "Alerta guia não-lida?" = Sim, o cliente que recebeu o protocolo por
// e-mail e ainda não abriu o documento recebe um lembrete X dias antes do
// vencimento — X vem da configuração geral (`ConfiguracaoEnvio`).
import type { ConfiguracaoEnvio } from "@prisma/client";
import { emailConfigurado, enviarEmail } from "../envio/email.js";
import { mensagemProtocolo } from "../envio/mensagem-protocolo.js";
import { dadosDoProtocolo } from "../envio/protocolo.js";
import { prisma } from "../prisma.js";

const FUSO = process.env.TZ_ESCRITORIO ?? "America/Fortaleza";
// Não manda lembrete de madrugada: só a partir desta hora (horário local).
const HORA_INICIO = 8;

export async function configuracaoEnvio(): Promise<ConfiguracaoEnvio> {
  return prisma.configuracaoEnvio.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

// "YYYY-MM-DD" do dia no fuso do escritório.
function diaLocal(data: Date): string {
  return data.toLocaleDateString("en-CA", { timeZone: FUSO });
}

function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(ate) - Date.parse(de)) / 86_400_000);
}

function horaLocal(data: Date): number {
  return Number(data.toLocaleString("en-US", { timeZone: FUSO, hour: "numeric", hourCycle: "h23" }));
}

// Qual lembrete está valendo hoje: o menor "dias antes" já alcançado.
// Ex.: dias [3, 1] e faltam 2 dias → lembrete de 3; falta 1 → lembrete de 1.
// Se o servidor ficou fora no dia exato, o lembrete sai no dia seguinte.
export function lembreteDoDia(diasConfigurados: number[], diasRestantes: number): number | null {
  if (diasRestantes < 0) return null;
  const alcancados = diasConfigurados.filter((d) => d >= diasRestantes);
  return alcancados.length > 0 ? Math.min(...alcancados) : null;
}

export async function enviarAlertasNaoLida(agora: Date = new Date()): Promise<number> {
  if (!emailConfigurado() || horaLocal(agora) < HORA_INICIO) return 0;
  const config = await configuracaoEnvio();
  const dias = config.diasAlertaNaoLida.filter((d) => d >= 0);
  if (dias.length === 0) return 0;

  const hoje = diaLocal(agora);
  const limite = new Date(agora.getTime() + (Math.max(...dias) + 1) * 86_400_000);
  const candidatos = await prisma.protocoloEntrega.findMany({
    where: {
      lidoEm: null,
      status: "ENVIADO",
      destinatarioEmail: { not: null },
      obrigacao: { dispensada: false, prazo: { gte: agora, lte: limite }, tipo: { alertaNaoLida: true } },
    },
    select: {
      id: true,
      numero: true,
      destinatarioNome: true,
      destinatarioEmail: true,
      enviadoEm: true,
      usuarioId: true,
      obrigacaoId: true,
      obrigacao: { select: { prazo: true } },
      alertasNaoLida: { select: { diasAntes: true } },
    },
  });

  let enviados = 0;
  for (const p of candidatos) {
    // Não lembra no mesmo dia em que o documento foi enviado.
    if (!p.enviadoEm || diaLocal(p.enviadoEm) >= hoje) continue;
    const diasRestantes = diasEntre(hoje, diaLocal(p.obrigacao.prazo));
    const diasAntes = lembreteDoDia(dias, diasRestantes);
    if (diasAntes === null || p.alertasNaoLida.some((a) => a.diasAntes === diasAntes)) continue;

    let erro: string | null = null;
    try {
      const dados = await dadosDoProtocolo(p.id, p.usuarioId);
      await enviarEmail(
        mensagemProtocolo(dados, { diasRestantes, prefixo: config.prefixoAlertaNaoLida, aviso: config.avisoCabecalho })
      );
    } catch (error) {
      erro = error instanceof Error ? error.message : String(error);
    }

    // Falha também fica registrada: não insiste no mesmo lembrete, e o
    // analista vê o erro no protocolo e no histórico da entrega.
    await prisma.alertaNaoLida.create({ data: { protocoloId: p.id, diasAntes, erro } });
    await prisma.logObrigacao.create({
      data: {
        obrigacaoId: p.obrigacaoId,
        acao: erro ? "alerta_nao_lida_falha" : "alerta_nao_lida",
        detalhe: erro
          ? `Protocolo nº ${p.numero}: falha no lembrete de guia não lida para ${p.destinatarioEmail} — ${erro}`
          : `Protocolo nº ${p.numero}: lembrete de guia não lida enviado a ${p.destinatarioNome} (${p.destinatarioEmail}), vence em ${diasRestantes} dia(s)`,
      },
    });
    if (!erro) enviados += 1;
  }
  return enviados;
}

// Roda na subida da API e a cada hora.
export function agendarAlertasNaoLida(): void {
  const rodar = () => {
    enviarAlertasNaoLida()
      .then((n) => {
        if (n > 0) console.log(`[alertas] ${n} lembrete(s) de guia não lida enviados`);
      })
      .catch((erro) => console.error("[alertas] falha nos lembretes de guia não lida", erro));
  };
  rodar();
  setInterval(rodar, 60 * 60 * 1000).unref();
}
