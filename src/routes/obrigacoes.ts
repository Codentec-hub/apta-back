// Lista de Entregas (modelo Acessórias): cada Obrigacao é a entrega de uma
// obrigação de um cliente numa competência.
import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { calcularEntrega, competenciaParaDate, somarMeses } from "../obrigacoes/prazos.js";
import { garantirFeriados } from "../obrigacoes/feriados.js";
import { gerarJanela } from "../obrigacoes/gerar-entregas.js";
import { prisma } from "../prisma.js";

export const obrigacoesRouter = Router();

obrigacoesRouter.use(autenticar);

const obrigacaoInclude = {
  cliente: { select: { id: true, razaoSocial: true, cnpj: true, codigo: true } },
  setor: true,
  tipo: true,
  responsavel: { select: { id: true, nome: true } },
  entreguePor: { select: { id: true, nome: true } },
  atraso: true,
  // Coluna "Protocolo de entrega": nº, destinatário, enviado/lido.
  protocolos: {
    select: { id: true, numero: true, destinatarioNome: true, status: true, enviadoEm: true, lidoEm: true },
    orderBy: { numero: "asc" },
  },
  _count: { select: { comentarios: true, documentos: true } },
} as const;

const competenciaSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Competência no formato AAAA-MM");

// Alterar prazo técnico/legal exige permissão (no Acessórias, concedida pelo
// administrador). Aqui: perfis ADMIN e GESTOR.
function podeAlterarPrazos(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

function formatarData(data: Date | null | undefined): string {
  return data ? data.toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" }) : "—";
}

async function registrarLog(obrigacaoId: string, req: Request, acao: string, detalhe: string): Promise<void> {
  await prisma.logObrigacao.create({
    data: { obrigacaoId, acao, detalhe, usuarioId: req.usuario?.usuarioId ?? null },
  });
}

// Filtros da Lista de Entregas do Acessórias: status (Pendentes /
// Justificadas / Entregues / Dispensadas, combináveis) e intervalos de
// competência, prazo técnico, prazo legal e data da entrega.
const listaSchema = z.object({
  clienteId: z.string().uuid().optional(),
  setorId: z.string().uuid().optional(),
  tipoId: z.string().uuid().optional(),
  responsavelId: z.string().uuid().optional(),
  status: z.string().optional(), // "pendentes,justificadas,entregues,dispensadas"
  competencia: competenciaSchema.optional(),
  competenciaDe: competenciaSchema.optional(),
  competenciaAte: competenciaSchema.optional(),
  prazoTecDe: z.string().date().optional(),
  prazoTecAte: z.string().date().optional(),
  prazoLegalDe: z.string().date().optional(),
  prazoLegalAte: z.string().date().optional(),
  entregaDe: z.string().date().optional(),
  entregaAte: z.string().date().optional(),
  // Situação dos documentos: "sem_documento", "nao_lidos", "lidos".
  docs: z.enum(["sem_documento", "nao_lidos", "lidos"]).optional(),
});

const FILTRO_DOCS: Record<string, Prisma.ObrigacaoWhereInput> = {
  sem_documento: { documentos: { none: {} } },
  nao_lidos: { protocolos: { some: { lidoEm: null } } },
  lidos: { protocolos: { some: {} }, NOT: { protocolos: { some: { lidoEm: null } } } },
};

// Dia civil (AAAA-MM-DD) em Fortaleza → intervalo em UTC.
function inicioDoDia(dia: string): Date {
  return new Date(`${dia}T03:00:00.000Z`);
}
function fimDoDia(dia: string): Date {
  return new Date(inicioDoDia(dia).getTime() + 24 * 3600 * 1000 - 1);
}
function intervalo(de?: string, ate?: string): Prisma.DateTimeFilter | undefined {
  if (!de && !ate) return undefined;
  return { ...(de && { gte: inicioDoDia(de) }), ...(ate && { lte: fimDoDia(ate) }) };
}

const FILTRO_STATUS: Record<string, Prisma.ObrigacaoWhereInput> = {
  pendentes: { concluidaEm: null, dispensada: false, atraso: null },
  justificadas: { concluidaEm: null, dispensada: false, atraso: { isNot: null } },
  entregues: { concluidaEm: { not: null }, dispensada: false },
  dispensadas: { dispensada: true },
};

obrigacoesRouter.get("/obrigacoes", asyncHandler(async (req, res) => {
  const parsed = listaSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const f = parsed.data;
  const status = (f.status ?? "").split(",").filter((s) => s in FILTRO_STATUS);
  const competencia =
    f.competencia !== undefined
      ? competenciaParaDate(f.competencia)
      : f.competenciaDe || f.competenciaAte
        ? {
            ...(f.competenciaDe && { gte: competenciaParaDate(f.competenciaDe) }),
            ...(f.competenciaAte && { lte: competenciaParaDate(f.competenciaAte) }),
          }
        : undefined;

  const obrigacoes = await prisma.obrigacao.findMany({
    where: {
      clienteId: f.clienteId,
      setorId: f.setorId,
      tipoId: f.tipoId,
      ...(f.responsavelId && { OR: [{ responsavelId: f.responsavelId }, { entreguePorId: f.responsavelId }] }),
      competencia,
      prazoTecnico: intervalo(f.prazoTecDe, f.prazoTecAte),
      prazo: intervalo(f.prazoLegalDe, f.prazoLegalAte),
      concluidaEm: intervalo(f.entregaDe, f.entregaAte),
      AND: [
        ...(status.length > 0 && status.length < 4 ? [{ OR: status.map((s) => FILTRO_STATUS[s]) }] : []),
        ...(f.docs ? [FILTRO_DOCS[f.docs]] : []),
      ],
    },
    orderBy: [{ prazoTecnico: "asc" }, { prazo: "asc" }, { cliente: { razaoSocial: "asc" } }],
    include: obrigacaoInclude,
  });
  res.json(obrigacoes);
}));

// Garante as pendências da janela (mês atual + 11) — opcionalmente só de
// uma empresa. A geração também roda sozinha a cada 6 horas.
obrigacoesRouter.post("/entregas/gerar", asyncHandler(async (req, res) => {
  const parsed = z.object({ clienteId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  res.json({ criadas: await gerarJanela({ clienteId: parsed.data.clienteId }) });
}));

const prazosEmMassaSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1),
    prazo: z.coerce.date().optional(),
    prazoTecnico: z.coerce.date().optional().nullable(),
  })
  .refine((d) => d.prazo !== undefined || d.prazoTecnico !== undefined, "Informe o novo prazo legal e/ou técnico");

// Alteração de prazos em massa. Mesmas travas do Acessórias: só entregas
// pendentes/justificadas (não entregues nem dispensadas), de UMA competência
// e de UMA obrigação.
obrigacoesRouter.post("/obrigacoes/prazos-em-massa", asyncHandler(async (req, res) => {
  if (!podeAlterarPrazos(req)) {
    res.status(403).json({ erro: "Sem permissão para alterar prazos" });
    return;
  }
  const parsed = prazosEmMassaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const { ids, prazo, prazoTecnico } = parsed.data;

  const entregas = await prisma.obrigacao.findMany({ where: { id: { in: ids } } });
  if (entregas.length !== ids.length) {
    res.status(404).json({ erro: "Alguma entrega selecionada não existe mais" });
    return;
  }
  if (entregas.some((e) => e.concluidaEm || e.dispensada)) {
    res.status(400).json({ erro: "Só é possível alterar em massa entregas pendentes ou justificadas" });
    return;
  }
  const competencias = new Set(entregas.map((e) => e.competencia?.toISOString() ?? "avulsa"));
  const tipos = new Set(entregas.map((e) => e.tipoId ?? e.nome));
  if (competencias.size > 1 || tipos.size > 1) {
    res.status(400).json({ erro: "Selecione entregas de uma única competência e de uma única obrigação" });
    return;
  }

  const partes: string[] = [];
  if (prazo !== undefined) partes.push(`prazo legal → ${formatarData(prazo)}`);
  if (prazoTecnico !== undefined) partes.push(`prazo técnico → ${formatarData(prazoTecnico)}`);

  await prisma.$transaction([
    prisma.obrigacao.updateMany({
      where: { id: { in: ids } },
      data: { ...(prazo !== undefined && { prazo }), ...(prazoTecnico !== undefined && { prazoTecnico }) },
    }),
    prisma.logObrigacao.createMany({
      data: entregas.map((e) => ({
        obrigacaoId: e.id,
        acao: "prazo_em_massa",
        detalhe: `Alteração em massa (${entregas.length} entregas): ${partes.join("; ")}`,
        usuarioId: req.usuario?.usuarioId ?? null,
      })),
    }),
  ]);

  const atualizadas = await prisma.obrigacao.findMany({ where: { id: { in: ids } }, include: obrigacaoInclude });
  res.json(atualizadas);
}));

obrigacoesRouter.get("/obrigacoes/:id", asyncHandler(async (req, res) => {
  const obrigacao = await prisma.obrigacao.findUnique({
    where: { id: req.params.id },
    include: obrigacaoInclude,
  });

  if (!obrigacao) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }

  res.json(obrigacao);
}));

obrigacoesRouter.get("/obrigacoes/:id/logs", asyncHandler(async (req, res) => {
  const logs = await prisma.logObrigacao.findMany({
    where: { obrigacaoId: req.params.id },
    orderBy: { createdAt: "desc" },
    include: { usuario: { select: { id: true, nome: true } } },
  });
  res.json(logs);
}));

// Entrega avulsa (fora da geração automática). Se vier tipo + competência
// sem prazo, o prazo sai da regra do Cadastro de Obrigações.
const criarObrigacaoSchema = z.object({
  nome: z.string().min(1),
  competencia: competenciaSchema.optional().nullable(),
  prazo: z.coerce.date().optional(),
  prazoTecnico: z.coerce.date().optional().nullable(),
  clienteId: z.string().uuid(),
  setorId: z.string().uuid(),
  tipoId: z.string().uuid().optional().nullable(),
  responsavelId: z.string().uuid().optional().nullable(),
  dispensada: z.boolean().optional(),
});

obrigacoesRouter.post("/obrigacoes", asyncHandler(async (req, res) => {
  const parsed = criarObrigacaoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const { competencia, ...dados } = parsed.data;

  let { prazo, prazoTecnico } = dados;
  if (!prazo && dados.tipoId && competencia) {
    // Mês de entrega = competência − "competências referentes a".
    const tipo = await prisma.tipoObrigacao.findUnique({ where: { id: dados.tipoId } });
    if (tipo && Math.abs(tipo.competenciaReferente) !== 12) {
      await garantirFeriados();
      const local = await prisma.cliente.findUnique({ where: { id: dados.clienteId }, select: { uf: true, cidade: true } });
      const [ano, mes] = competencia.split("-").map(Number);
      const m = somarMeses(ano, mes, -tipo.competenciaReferente);
      const calculada = calcularEntrega(tipo, m.ano, m.mes, local ?? {});
      if (calculada) ({ prazo, prazoTecnico } = calculada);
    }
  }
  if (!prazo) {
    res.status(400).json({ erro: "Informe o prazo legal (ou tipo + competência para calcular)" });
    return;
  }

  if (dados.tipoId && competencia) {
    const duplicada = await prisma.obrigacao.findFirst({
      where: { clienteId: dados.clienteId, tipoId: dados.tipoId, competencia: competenciaParaDate(competencia) },
    });
    if (duplicada) {
      res.status(409).json({ erro: "Já existe essa entrega para este cliente nesta competência" });
      return;
    }
  }

  const obrigacao = await prisma.obrigacao.create({
    data: {
      ...dados,
      prazo,
      prazoTecnico,
      competencia: competencia ? competenciaParaDate(competencia) : null,
    },
    include: obrigacaoInclude,
  });
  await registrarLog(obrigacao.id, req, "criada", "Entrega criada manualmente");
  res.status(201).json(obrigacao);
}));

const atualizarObrigacaoSchema = z.object({
  nome: z.string().min(1).optional(),
  prazo: z.coerce.date().optional(),
  prazoTecnico: z.coerce.date().optional().nullable(),
  setorId: z.string().uuid().optional(),
  tipoId: z.string().uuid().optional().nullable(),
  responsavelId: z.string().uuid().optional().nullable(),
  dispensada: z.boolean().optional(),
  tempoRealMinutos: z.coerce.number().int().min(0).optional().nullable(),
});

obrigacoesRouter.put("/obrigacoes/:id", asyncHandler(async (req, res) => {
  const parsed = atualizarObrigacaoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const existente = await prisma.obrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }

  const { prazo, prazoTecnico } = parsed.data;
  const mudouPrazo = prazo !== undefined && prazo.getTime() !== existente.prazo.getTime();
  const mudouTecnico =
    prazoTecnico !== undefined && (prazoTecnico?.getTime() ?? null) !== (existente.prazoTecnico?.getTime() ?? null);

  if ((mudouPrazo || mudouTecnico) && !podeAlterarPrazos(req)) {
    res.status(403).json({ erro: "Sem permissão para alterar prazos" });
    return;
  }

  const obrigacao = await prisma.obrigacao.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: obrigacaoInclude,
  });

  if (mudouPrazo) {
    await registrarLog(obrigacao.id, req, "prazo_alterado", `Prazo legal: ${formatarData(existente.prazo)} → ${formatarData(prazo)}`);
  }
  if (mudouTecnico) {
    await registrarLog(
      obrigacao.id,
      req,
      "prazo_alterado",
      `Prazo técnico: ${formatarData(existente.prazoTecnico)} → ${formatarData(prazoTecnico)}`
    );
  }
  if (parsed.data.dispensada !== undefined && parsed.data.dispensada !== existente.dispensada) {
    await registrarLog(obrigacao.id, req, "dispensa", parsed.data.dispensada ? "Marcada como dispensada" : "Dispensa removida");
  }

  res.json(obrigacao);
}));

const concluirObrigacaoSchema = z.object({
  tempoRealMinutos: z.coerce.number().int().min(0).optional().nullable(),
  // Data da entrega, quando registrada depois do fato (padrão: agora).
  entregueEm: z.coerce.date().optional().nullable(),
  comentario: z.string().optional().nullable(),
});

obrigacoesRouter.post("/obrigacoes/:id/concluir", asyncHandler(async (req, res) => {
  const parsed = concluirObrigacaoSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const existente = await prisma.obrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }

  const concluidaEm = parsed.data.entregueEm ?? new Date();
  if (concluidaEm.getTime() > Date.now() + 60_000) {
    res.status(400).json({ erro: "A data da entrega não pode estar no futuro" });
    return;
  }

  const obrigacao = await prisma.obrigacao.update({
    where: { id: req.params.id },
    data: {
      concluidaEm,
      tempoRealMinutos: parsed.data.tempoRealMinutos,
      entreguePorId: req.usuario?.usuarioId ?? null,
    },
    include: obrigacaoInclude,
  });
  await registrarLog(obrigacao.id, req, "entregue", `Entregue em ${formatarData(concluidaEm)}`);
  if (parsed.data.comentario?.trim()) {
    await prisma.comentarioEntrega.create({
      data: { obrigacaoId: obrigacao.id, texto: parsed.data.comentario.trim(), usuarioId: req.usuario?.usuarioId ?? null },
    });
  }
  res.json(await prisma.obrigacao.findUnique({ where: { id: obrigacao.id }, include: obrigacaoInclude }));
}));

obrigacoesRouter.post("/obrigacoes/:id/reabrir", asyncHandler(async (req, res) => {
  const existente = await prisma.obrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }

  const obrigacao = await prisma.obrigacao.update({
    where: { id: req.params.id },
    data: { concluidaEm: null, entreguePorId: null },
    include: obrigacaoInclude,
  });
  await registrarLog(obrigacao.id, req, "reaberta", `Entrega de ${formatarData(existente.concluidaEm)} desfeita`);
  res.json(obrigacao);
}));

obrigacoesRouter.delete("/obrigacoes/:id", asyncHandler(async (req, res) => {
  const existente = await prisma.obrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }

  await prisma.obrigacao.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

const registrarAtrasoSchema = z.object({
  justificativa: z.string().min(1),
  causaRaiz: z.string().min(1),
  planoDeAcao: z.string().min(1),
  prazoPrometido: z.coerce.date(),
});

obrigacoesRouter.put("/obrigacoes/:id/atraso", asyncHandler(async (req, res) => {
  const parsed = registrarAtrasoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const existente = await prisma.obrigacao.findUnique({ where: { id: req.params.id }, include: { atraso: true } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }

  const atraso = await prisma.atraso.upsert({
    where: { obrigacaoId: req.params.id },
    update: parsed.data,
    create: { ...parsed.data, obrigacaoId: req.params.id },
  });
  await registrarLog(
    req.params.id,
    req,
    "justificativa",
    `${existente.atraso ? "Justificativa atualizada" : "Entrega justificada"} — plano prometido para ${formatarData(parsed.data.prazoPrometido)}`
  );

  res.json(atraso);
}));

obrigacoesRouter.post("/obrigacoes/:id/atraso/cumprir", asyncHandler(async (req, res) => {
  const atrasoExistente = await prisma.atraso.findUnique({ where: { obrigacaoId: req.params.id } });
  if (!atrasoExistente) {
    res.status(404).json({ erro: "Nenhum atraso registrado para esta obrigação" });
    return;
  }

  const atraso = await prisma.atraso.update({
    where: { obrigacaoId: req.params.id },
    data: { cumprido: true, cumpridoEm: new Date() },
  });
  await registrarLog(req.params.id, req, "plano_cumprido", "Plano de ação confirmado como cumprido");
  res.json(atraso);
}));

obrigacoesRouter.get("/obrigacoes/:id/comentarios", asyncHandler(async (req, res) => {
  const comentarios = await prisma.comentarioEntrega.findMany({
    where: { obrigacaoId: req.params.id },
    orderBy: { createdAt: "desc" },
    include: { usuario: { select: { id: true, nome: true } } },
  });
  res.json(comentarios);
}));

obrigacoesRouter.post("/obrigacoes/:id/comentarios", asyncHandler(async (req, res) => {
  const parsed = z.object({ texto: z.string().trim().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Escreva o comentário" });
    return;
  }
  const existente = await prisma.obrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }
  const comentario = await prisma.comentarioEntrega.create({
    data: { obrigacaoId: existente.id, texto: parsed.data.texto, usuarioId: req.usuario?.usuarioId ?? null },
    include: { usuario: { select: { id: true, nome: true } } },
  });
  res.status(201).json(comentario);
}));
