// Parâmetros do assistente de leads: fila de disparo, textos, prazo da
// pré-reserva e quem é avisado. Leitura para todos; alteração só gestão.
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { somenteGestao } from "../middleware/perfil.js";
import { prisma } from "../prisma.js";
import { emitirEvento } from "../eventos.js";
import { CONFIRMACAO_PADRAO, INSTRUCOES_PADRAO, LEMBRETE_PADRAO, MENSAGENS_INICIAIS_PADRAO, agenteDosLeads, configLeads } from "../leads/config.js";
import { situacaoDaFila } from "../leads/disparo.js";
import { paraMinutos } from "../leads/tempo.js";

export const configuracaoLeadsRouter = Router();
configuracaoLeadsRouter.use("/configuracoes/leads", autenticar);

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

configuracaoLeadsRouter.get(
  "/configuracoes/leads",
  asyncHandler(async (_req, res) => {
    const agente = await agenteDosLeads();
    const { proximoDisparoEm: _p, ...config } = await configLeads();
    res.json({
      ...config,
      agente,
      fila: await situacaoDaFila(),
      padroes: { mensagensIniciais: MENSAGENS_INICIAIS_PADRAO, mensagemLembrete: LEMBRETE_PADRAO, mensagemConfirmacao: CONFIRMACAO_PADRAO, instrucoes: INSTRUCOES_PADRAO },
    });
  })
);

const schema = z
  .object({
    disparoAtivo: z.boolean(),
    disparoAutomatico: z.boolean(),
    intervaloMinMin: z.number().int().min(1).max(240),
    intervaloMaxMin: z.number().int().min(1).max(480),
    tetoDiario: z.number().int().min(1).max(500),
    horaInicio: z.string().regex(HORA),
    horaFim: z.string().regex(HORA),
    diasSemana: z.array(z.number().int().min(0).max(6)).min(1, "Escolha pelo menos um dia"),
    lembreteHoras: z.number().int().min(1).max(168),
    prazoPreReservaHoras: z.number().int().min(1).max(168),
    antecedenciaMinHoras: z.number().int().min(0).max(168),
    diasAgendaAberta: z.number().int().min(1).max(90),
    nomeIndicador: z.string().trim().min(1).max(60),
    mensagensIniciais: z.array(z.string().trim().max(1000)).max(10),
    mensagemLembrete: z.string().trim().max(1000).nullable(),
    enviarConfirmacao: z.boolean(),
    mensagemConfirmacao: z.string().trim().max(1000).nullable(),
    formatoAtendimento: z.string().trim().min(1).max(200),
    notificarIds: z.array(z.string().uuid()).max(50),
    agenteId: z.string().uuid().nullable(),
  })
  .partial()
  .refine((c) => c.intervaloMinMin === undefined || c.intervaloMaxMin === undefined || c.intervaloMaxMin >= c.intervaloMinMin, {
    message: "O intervalo máximo precisa ser maior ou igual ao mínimo",
  })
  .refine((c) => !c.horaInicio || !c.horaFim || paraMinutos(c.horaFim) > paraMinutos(c.horaInicio), {
    message: "O horário final do envio precisa ser depois do inicial",
  });

configuracaoLeadsRouter.put(
  "/configuracoes/leads",
  somenteGestao,
  asyncHandler(async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Configuração inválida" });
      return;
    }
    const dados = parsed.data;
    if (dados.mensagensIniciais) dados.mensagensIniciais = dados.mensagensIniciais.filter(Boolean);
    if (dados.mensagensIniciais?.some((m) => /https?:\/\/|www\./i.test(m))) {
      res.status(400).json({ erro: "A primeira mensagem não pode ter links (aumenta o risco de bloqueio do número)" });
      return;
    }
    if (dados.agenteId && !(await prisma.agenteIA.findUnique({ where: { id: dados.agenteId } }))) {
      res.status(400).json({ erro: "Agente não encontrado" });
      return;
    }
    // Confere contra o que já está salvo (a tela pode mandar só parte dos campos).
    const atual = await configLeads();
    const final = { ...atual, ...dados };
    if (final.intervaloMaxMin < final.intervaloMinMin) {
      res.status(400).json({ erro: "O intervalo máximo precisa ser maior ou igual ao mínimo" });
      return;
    }
    if (paraMinutos(final.horaFim) <= paraMinutos(final.horaInicio)) {
      res.status(400).json({ erro: "O horário final do envio precisa ser depois do inicial" });
      return;
    }
    await prisma.configuracaoLeads.update({ where: { id: 1 }, data: dados });
    emitirEvento({ tipo: "leads" });
    res.status(204).send();
  })
);
