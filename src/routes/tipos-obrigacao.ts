// Cadastro de Obrigações (modelo Acessórias): cada tipo carrega a regra que
// gera as entregas mês a mês, mais as ações Replicar, Retro e Avulsa e a
// lista de empresas que precisam entregar a obrigação.
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import {
  gerarJanela,
  gerarRetroativas,
  recalcularFuturas,
  removerFuturasIntocadas,
} from "../obrigacoes/gerar-entregas.js";
import { garantirFeriados } from "../obrigacoes/feriados.js";
import { calcularEntrega, competenciaParaDate, mesAtual, somarMeses } from "../obrigacoes/prazos.js";
import { prisma } from "../prisma.js";

export const tiposObrigacaoRouter = Router();

tiposObrigacaoRouter.use(autenticar);

const tipoInclude = {
  setor: { include: { responsavel: { select: { id: true, nome: true } } } },
  _count: { select: { empresas: { where: { ativa: true } } } },
} as const;

const codigoMes = z.coerce
  .number()
  .int()
  .refine((c) => c === 0 || (c >= 1 && c <= 31) || (c >= 51 && c <= 70) || c === 90, "Código de data inválido");

const regraSchema = z.object({
  entregasPorMes: z.array(codigoMes).length(12),
  competenciaReferente: z.coerce.number().int().refine((v) => [-12, -3, -2, -1, 0, 1, 12].includes(v)),
  diasAntes: z.coerce.number().int().min(0).max(180),
  tipoDiasAntes: z.enum(["UTEIS", "CORRIDOS"]),
  ajustePrazo: z.enum(["ANTECIPAR", "POSTERGAR", "MANTER"]),
  sabadoUtil: z.boolean(),
});

const tipoObrigacaoSchema = regraSchema.partial().extend({
  nome: z.string().min(1),
  mininome: z.string().optional().nullable(),
  setorId: z.string().uuid(),
  tempoPrevistoMinutos: z.coerce.number().int().min(0).optional().nullable(),
  geraMulta: z.boolean().optional(),
  alertaNaoLida: z.boolean().optional(),
  comentarioPadrao: z.string().optional().nullable(),
  ativo: z.boolean().optional(),
});

const CAMPOS_DA_REGRA = [
  "entregasPorMes",
  "competenciaReferente",
  "diasAntes",
  "tipoDiasAntes",
  "ajustePrazo",
  "sabadoUtil",
  "setorId",
  "nome",
] as const;

tiposObrigacaoRouter.get("/tipos-obrigacao", asyncHandler(async (_req, res) => {
  const tipos = await prisma.tipoObrigacao.findMany({
    orderBy: [{ nome: "asc" }],
    include: tipoInclude,
  });
  res.json(tipos);
}));

tiposObrigacaoRouter.post("/tipos-obrigacao", asyncHandler(async (req, res) => {
  const parsed = tipoObrigacaoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const jaExiste = await prisma.tipoObrigacao.findFirst({
    where: { nome: parsed.data.nome, setorId: parsed.data.setorId },
  });
  if (jaExiste) {
    res.status(409).json({ erro: "Já existe uma obrigação com este nome neste departamento" });
    return;
  }

  const tipo = await prisma.tipoObrigacao.create({ data: parsed.data, include: tipoInclude });
  res.status(201).json(tipo);
}));

tiposObrigacaoRouter.put("/tipos-obrigacao/:id", asyncHandler(async (req, res) => {
  const parsed = tipoObrigacaoSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const existente = await prisma.tipoObrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }

  const tipo = await prisma.tipoObrigacao.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: tipoInclude,
  });

  // Mudou a regra (ou ativou/desativou): as pendências futuras intocadas são
  // refeitas para refletir o cadastro, como no Acessórias.
  const mudouRegra = CAMPOS_DA_REGRA.some(
    (campo) => parsed.data[campo] !== undefined && JSON.stringify(parsed.data[campo]) !== JSON.stringify(existente[campo])
  );
  if (parsed.data.ativo === false && existente.ativo) {
    await removerFuturasIntocadas({ tipoId: tipo.id });
  } else if (mudouRegra || (parsed.data.ativo === true && !existente.ativo)) {
    await recalcularFuturas({ tipoId: tipo.id });
  }

  res.json(tipo);
}));

// Pré-visualiza as próximas 12 entregas que a regra gera.
tiposObrigacaoRouter.post("/tipos-obrigacao/simular-prazos", asyncHandler(async (req, res) => {
  const parsed = regraSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  await garantirFeriados();
  // Sem empresa específica: simula com a localidade do escritório.
  const local = { uf: process.env.ESCRITORIO_UF ?? "CE", cidade: process.env.ESCRITORIO_CIDADE ?? "Fortaleza" };
  const { ano, mes } = mesAtual();
  const resultado = [];
  for (let i = 0; i < 12; i++) {
    const m = somarMeses(ano, mes, i);
    const entrega = calcularEntrega(parsed.data, m.ano, m.mes, local);
    if (entrega) resultado.push(entrega);
  }
  res.json(resultado);
}));

// "Replicar obrigação": cria uma cópia do cadastro com outro nome.
tiposObrigacaoRouter.post("/tipos-obrigacao/:id/replicar", asyncHandler(async (req, res) => {
  const parsed = z.object({ nome: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Informe o nome da nova obrigação" });
    return;
  }
  const origem = await prisma.tipoObrigacao.findUnique({ where: { id: req.params.id } });
  if (!origem) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }
  if (await prisma.tipoObrigacao.findFirst({ where: { nome: parsed.data.nome, setorId: origem.setorId } })) {
    res.status(409).json({ erro: "Já existe uma obrigação com este nome neste departamento" });
    return;
  }
  const { id: _id, createdAt: _createdAt, ...dados } = origem;
  const copia = await prisma.tipoObrigacao.create({ data: { ...dados, nome: parsed.data.nome }, include: tipoInclude });
  res.status(201).json(copia);
}));

// "Retro": gera as pendências retroativas desta obrigação desde um mês.
tiposObrigacaoRouter.post("/tipos-obrigacao/:id/retro", asyncHandler(async (req, res) => {
  const parsed = z.object({ desde: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Informe o mês inicial (AAAA-MM)" });
    return;
  }
  const [ano, mes] = parsed.data.desde.split("-").map(Number);
  const criadas = await gerarRetroativas({ ano, mes }, { tipoId: req.params.id });
  res.json({ criadas });
}));

// "Avulsa": lança uma entrega desta obrigação fora da regra, para as
// empresas escolhidas (ex.: uma declaração extra num mês específico).
tiposObrigacaoRouter.post("/tipos-obrigacao/:id/avulsa", asyncHandler(async (req, res) => {
  const parsed = z
    .object({
      clienteIds: z.array(z.string().uuid()).min(1),
      competencia: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      prazo: z.coerce.date(),
      prazoTecnico: z.coerce.date().optional().nullable(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const tipo = await prisma.tipoObrigacao.findUnique({ where: { id: req.params.id }, include: { setor: true } });
  if (!tipo) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }
  const competencia = competenciaParaDate(parsed.data.competencia);
  const clientes = await prisma.cliente.findMany({
    where: { id: { in: parsed.data.clienteIds } },
    include: { responsaveis: true, obrigacoesEmpresa: { where: { tipoId: tipo.id } } },
  });

  let criadas = 0;
  let jaExistiam = 0;
  for (const cliente of clientes) {
    const existe = await prisma.obrigacao.findFirst({ where: { clienteId: cliente.id, tipoId: tipo.id, competencia } });
    if (existe) {
      jaExistiam += 1;
      continue;
    }
    const entrega = await prisma.obrigacao.create({
      data: {
        nome: tipo.nome,
        competencia,
        prazo: parsed.data.prazo,
        prazoTecnico: parsed.data.prazoTecnico ?? parsed.data.prazo,
        clienteId: cliente.id,
        setorId: tipo.setorId,
        tipoId: tipo.id,
        responsavelId:
          cliente.obrigacoesEmpresa[0]?.responsavelId ??
          cliente.responsaveis.find((r) => r.setorId === tipo.setorId)?.usuarioId ??
          tipo.setor.responsavelId,
      },
    });
    await prisma.logObrigacao.create({
      data: { obrigacaoId: entrega.id, acao: "criada", detalhe: "Entrega avulsa", usuarioId: req.usuario?.usuarioId ?? null },
    });
    criadas += 1;
  }
  res.json({ criadas, jaExistiam });
}));

// "Empresas que precisam entregar essa obrigação".
tiposObrigacaoRouter.get("/tipos-obrigacao/:id/empresas", asyncHandler(async (req, res) => {
  const empresas = await prisma.clienteObrigacao.findMany({
    where: { tipoId: req.params.id },
    include: {
      cliente: { select: { id: true, razaoSocial: true, cnpj: true, ativo: true } },
      responsavel: { select: { id: true, nome: true } },
    },
    orderBy: { cliente: { razaoSocial: "asc" } },
  });
  res.json(empresas);
}));

// "Adicionar empresa a essa obrigação".
tiposObrigacaoRouter.post("/tipos-obrigacao/:id/empresas", asyncHandler(async (req, res) => {
  const parsed = z.object({ clienteIds: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const tipo = await prisma.tipoObrigacao.findUnique({ where: { id: req.params.id } });
  if (!tipo) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }
  await prisma.$transaction([
    prisma.clienteObrigacao.updateMany({
      where: { tipoId: tipo.id, clienteId: { in: parsed.data.clienteIds } },
      data: { ativa: true },
    }),
    prisma.clienteObrigacao.createMany({
      data: parsed.data.clienteIds.map((clienteId) => ({ clienteId, tipoId: tipo.id })),
      skipDuplicates: true,
    }),
  ]);
  for (const clienteId of parsed.data.clienteIds) await gerarJanela({ tipoId: tipo.id, clienteId });
  res.json({ ok: true });
}));
