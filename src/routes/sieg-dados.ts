// Dados da SIEG para as telas (notas, contagens, relatórios, saúde da
// integração). Tudo é leitura: as rotas que consultam a SIEG passam por
// sieg/cliente.ts, que só permite rotas de consulta e respeita os limites.
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";
import { credenciaisConfiguradas } from "../sieg/auth.js";
import { ErroSieg } from "../sieg/cliente.js";
import {
  atualizarStatusCertificado,
  baixarXmlNota,
  estadoContagens,
  eventosNota,
  gerarDanfeNota,
  gerarRelatorio,
  iniciarCapturaNotas,
  iniciarContagemTodas,
  contarNotasEmpresa,
  mesesRecentes,
  RELATORIOS,
  TIPOS_XML,
  type TipoNota,
  type TipoRelatorio,
  zipXmlsMes,
} from "../sieg/notas.js";
import { renovarTokenOAuth } from "../sieg/oauth.js";
import { estadoAgendamento, estadoCapturaNoturna, mesesAbertos, sincronizacaoCompleta } from "../sieg/agendamento.js";

export const siegDadosRouter = Router();
siegDadosRouter.use("/sieg/dados", autenticar);

const podeAcionar = (req: Request) => req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
const mesSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês no formato AAAA-MM");
const docSchema = z.string().transform((v) => v.replace(/\D/g, "")).refine((v) => v.length === 11 || v.length === 14, "CNPJ/CPF inválido");
const tipoSchema = z.enum(Object.keys(TIPOS_XML) as [TipoNota, ...TipoNota[]]);
const papelSchema = z.enum(["emitente", "destinatario"]);

/** Erro da SIEG vira 502 com a mensagem dela; o resto segue para o handler geral. */
function responderErroSieg(res: Response, error: unknown): boolean {
  if (error instanceof ErroSieg || (error instanceof Error && /SIEG|OAuth/i.test(error.message))) {
    res.status(502).json({ erro: error.message });
    return true;
  }
  return false;
}

function enviarArquivo(res: Response, nome: string, conteudo: Buffer, tipo: string) {
  res.setHeader("Content-Type", tipo);
  res.setHeader("Content-Disposition", `attachment; filename="${nome.replace(/"/g, "")}"`);
  res.send(conteudo);
}

// ------------------------------------------------------------------ saúde

siegDadosRouter.get("/sieg/dados/saude", asyncHandler(async (_req, res) => {
  const desde = new Date(Date.now() - 24 * 3_600_000);
  const [config, chamadas, ultimosErros, empresas, contagens, notas] = await Promise.all([
    prisma.configuracaoSieg.findUnique({ where: { id: 1 } }),
    prisma.siegChamada.groupBy({
      by: ["rota"],
      where: { criadoEm: { gte: desde } },
      _count: { _all: true },
      _avg: { duracaoMs: true },
    }),
    prisma.siegChamada.findMany({
      where: { erro: { not: null } },
      orderBy: { criadoEm: "desc" },
      take: 15,
      select: { rota: true, status: true, erro: true, criadoEm: true },
    }),
    prisma.siegEmpresa.count({ where: { ativo: true, deletado: false } }),
    prisma.siegContagem.findFirst({ orderBy: { atualizadoEm: "desc" }, select: { atualizadoEm: true } }),
    prisma.siegNota.count(),
  ]);
  const errosPorRota = await prisma.siegChamada.groupBy({
    by: ["rota"],
    where: { criadoEm: { gte: desde }, erro: { not: null } },
    _count: { _all: true },
  });
  const erros = new Map(errosPorRota.map((e) => [e.rota, e._count._all]));
  const expira = config?.oauthExpiraEm ?? null;
  res.json({
    credenciaisConfiguradas: await credenciaisConfiguradas(),
    token: {
      autorizado: Boolean(config?.oauthToken && expira && expira > new Date()),
      expiraEm: expira,
      diasParaVencer: expira ? Math.floor((expira.getTime() - Date.now()) / 86_400_000) : null,
      renovadoEm: config?.oauthRenovadoEm ?? null,
      erroRenovacao: config?.oauthErroRenovacao ?? null,
    },
    sincronizacao: {
      ultimaEm: config?.ultimaSincronizacaoEm ?? null,
      erro: config?.ultimaSincronizacaoErro ?? null,
      agendamento: estadoAgendamento(),
      contagens: estadoContagens(),
      ultimaContagemEm: contagens?.atualizadoEm ?? null,
      captura: {
        ...estadoCapturaNoturna(),
        ultimaEm: config?.ultimaCapturaEm ?? null,
        ultimoResumo: config?.ultimaCapturaResumo ?? null,
      },
    },
    corte: await mesesAbertos(),
    dados: { empresasAtivas: empresas, notasCapturadas: notas },
    chamadas24h: chamadas
      .map((c) => ({
        rota: c.rota,
        total: c._count._all,
        erros: erros.get(c.rota) ?? 0,
        mediaMs: Math.round(c._avg.duracaoMs ?? 0),
      }))
      .sort((a, b) => b.total - a.total),
    ultimosErros,
  });
}));

siegDadosRouter.post("/sieg/dados/token/renovar", asyncHandler(async (req, res) => {
  if (!podeAcionar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem renovar o token" });
    return;
  }
  try {
    res.json(await renovarTokenOAuth());
  } catch (error) {
    if (!responderErroSieg(res, error)) throw error;
  }
}));

siegDadosRouter.post("/sieg/dados/sincronizar", asyncHandler(async (req, res) => {
  if (req.usuario?.perfil !== "ADMIN") {
    res.status(403).json({ erro: "Apenas administradores podem rodar a busca completa" });
    return;
  }
  if (estadoAgendamento().rodando) {
    res.status(409).json({ erro: "Já há uma busca completa em andamento" });
    return;
  }
  // Pelo botão a captura não para às 8h: quem clicou quer o resultado agora.
  void sincronizacaoCompleta(false).catch((e) => console.error("[sieg] falha na busca completa", e));
  res.json({ iniciada: true });
}));

// --------------------------------------------------------------- contagens

siegDadosRouter.get("/sieg/dados/contagens", asyncHandler(async (req, res) => {
  const mes = mesSchema.safeParse(req.query["mes"] ?? mesesRecentes(1)[0]);
  if (!mes.success) {
    res.status(400).json({ erro: "Informe o mês no formato AAAA-MM" });
    return;
  }
  const [empresas, contagens, clientes] = await Promise.all([
    prisma.siegEmpresa.findMany({ where: { ativo: true, deletado: false }, orderBy: { nome: "asc" } }),
    prisma.siegContagem.findMany({ where: { mes: mes.data } }),
    prisma.cliente.findMany({ select: { id: true, cnpj: true } }),
  ]);
  const porChave = new Map(contagens.map((c) => [`${c.documento}|${c.papel}`, c]));
  const clientePorDoc = new Map(clientes.map((c) => [c.cnpj.replace(/\D/g, ""), c.id]));
  const zero = { nfe: 0, nfce: 0, cte: 0, cfe: 0, nfse: 0 };
  const resumo = (c?: (typeof contagens)[number]) =>
    c ? { nfe: c.nfe, nfce: c.nfce, cte: c.cte, cfe: c.cfe, nfse: c.nfse } : null;
  res.json({
    mes: mes.data,
    andamento: estadoContagens(),
    empresas: empresas.map((e) => {
      const emit = porChave.get(`${e.documento}|emitente`);
      const dest = porChave.get(`${e.documento}|destinatario`);
      return {
        documento: e.documento,
        nome: e.nome,
        clienteId: clientePorDoc.get(e.documento) ?? null,
        emitidas: resumo(emit) ?? (dest ? zero : null),
        recebidas: resumo(dest) ?? (emit ? zero : null),
        atualizadoEm: (emit ?? dest)?.atualizadoEm ?? null,
      };
    }),
  });
}));

const contarSchema = z.object({ mes: mesSchema, documento: docSchema.optional() });

siegDadosRouter.post("/sieg/dados/contagens/atualizar", asyncHandler(async (req, res) => {
  if (!podeAcionar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem atualizar as contagens" });
    return;
  }
  const parsed = contarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Informe o mês (AAAA-MM)" });
    return;
  }
  if (parsed.data.documento) {
    try {
      await contarNotasEmpresa(parsed.data.documento, parsed.data.mes);
      res.json({ ok: true });
    } catch (error) {
      if (!responderErroSieg(res, error)) throw error;
    }
    return;
  }
  res.json(iniciarContagemTodas(parsed.data.mes));
}));

// -------------------------------------------------------------------- notas

const filtroNotas = z.object({
  documento: docSchema,
  mes: mesSchema,
  tipo: tipoSchema,
  papel: papelSchema,
});

siegDadosRouter.get("/sieg/dados/notas", asyncHandler(async (req, res) => {
  const parsed = filtroNotas.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ erro: "Escolha empresa, mês, tipo de nota e se são emitidas ou recebidas" });
    return;
  }
  const { documento, mes, tipo, papel } = parsed.data;
  const [notas, busca] = await Promise.all([
    prisma.siegNota.findMany({
      where: { documentoEmpresa: documento, mes, tipo, papel },
      omit: { xml: true },
      orderBy: [{ emissao: "desc" }, { numero: "desc" }],
    }),
    prisma.siegBuscaNotas.findFirst({ where: { documento, mes, tipo, papel }, orderBy: { iniciadaEm: "desc" } }),
  ]);
  res.json({ notas, busca, total: notas.reduce((s, n) => s + (n.valor ?? 0), 0) });
}));

siegDadosRouter.post("/sieg/dados/notas/capturar", asyncHandler(async (req, res) => {
  if (!podeAcionar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem buscar notas na SIEG" });
    return;
  }
  const parsed = filtroNotas.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Escolha empresa, mês, tipo de nota e se são emitidas ou recebidas" });
    return;
  }
  const { documento, mes, tipo, papel } = parsed.data;
  res.json(await iniciarCapturaNotas(documento, mes, tipo, papel));
}));

// Data de corte: até esse dia o mês anterior ainda é atualizado de noite.
siegDadosRouter.put("/sieg/dados/corte", asyncHandler(async (req, res) => {
  if (!podeAcionar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar a data de corte" });
    return;
  }
  const parsed = z.object({ diaCorte: z.number().int().min(1).max(28) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Dia de corte entre 1 e 28" });
    return;
  }
  await prisma.configuracaoSieg.upsert({
    where: { id: 1 },
    create: { id: 1, diaCorte: parsed.data.diaCorte },
    update: { diaCorte: parsed.data.diaCorte },
  });
  res.json(await mesesAbertos());
}));

// ZIP com os XMLs guardados do mês (pastas emitidas/ e recebidas/), para a Domínio.
siegDadosRouter.get("/sieg/dados/notas/zip", asyncHandler(async (req, res) => {
  const parsed = z.object({ documento: docSchema, mes: mesSchema }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ erro: "Escolha a empresa e o mês" });
    return;
  }
  const zip = await zipXmlsMes(parsed.data.documento, parsed.data.mes);
  if (zip.total === 0) {
    res.status(404).json({ erro: "Nenhum XML guardado desta empresa nesse mês. Busque as notas primeiro." });
    return;
  }
  enviarArquivo(res, zip.nome, zip.conteudo, "application/zip");
}));

siegDadosRouter.get("/sieg/dados/notas/:chave/xml", asyncHandler(async (req, res) => {
  try {
    const a = await baixarXmlNota(String(req.params["chave"]));
    enviarArquivo(res, a.nome, a.conteudo, "application/xml");
  } catch (error) {
    if (!responderErroSieg(res, error)) throw error;
  }
}));

siegDadosRouter.get("/sieg/dados/notas/:chave/danfe", asyncHandler(async (req, res) => {
  try {
    const a = await gerarDanfeNota(String(req.params["chave"]));
    enviarArquivo(res, a.nome, a.conteudo, "application/pdf");
  } catch (error) {
    if (!responderErroSieg(res, error)) throw error;
  }
}));

siegDadosRouter.get("/sieg/dados/notas/:chave/eventos", asyncHandler(async (req, res) => {
  try {
    res.json(await eventosNota(String(req.params["chave"])));
  } catch (error) {
    if (!responderErroSieg(res, error)) throw error;
  }
}));

// --------------------------------------------------------------- relatórios

siegDadosRouter.get("/sieg/dados/relatorios/tipos", (_req, res) => {
  res.json(
    Object.entries(RELATORIOS).map(([chave, r]) => ({
      chave,
      nome: r.nome,
      tipos: Object.entries(TIPOS_XML)
        .filter(([, n]) => (r.tiposXml as readonly number[]).includes(n))
        .map(([t]) => t),
    })),
  );
});

const relatorioSchema = z.object({
  documento: docSchema,
  mes: mesSchema,
  relatorio: z.enum(Object.keys(RELATORIOS) as [TipoRelatorio, ...TipoRelatorio[]]),
  tipo: tipoSchema,
});

siegDadosRouter.post("/sieg/dados/relatorios", asyncHandler(async (req, res) => {
  const parsed = relatorioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Escolha empresa, mês, relatório e tipo de nota" });
    return;
  }
  const { documento, mes, relatorio, tipo } = parsed.data;
  try {
    const a = await gerarRelatorio(documento, mes, relatorio, tipo);
    const tipoMime =
      a.tipo === "pdf" ? "application/pdf" : a.nome.endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    enviarArquivo(res, a.nome, a.conteudo, tipoMime);
  } catch (error) {
    if (!responderErroSieg(res, error)) throw error;
  }
}));

// ---------------------------------------------------- status do certificado

siegDadosRouter.post("/sieg/dados/empresas/:id/status", asyncHandler(async (req, res) => {
  const id = String(req.params["id"]);
  if (!(await prisma.siegEmpresa.findUnique({ where: { id } }))) {
    res.status(404).json({ erro: "Empresa não encontrada na lista da SIEG" });
    return;
  }
  try {
    res.json(await atualizarStatusCertificado(id));
  } catch (error) {
    if (!responderErroSieg(res, error)) throw error;
  }
}));

// ------------------------------------------------- resumo na ficha do cliente

siegDadosRouter.get("/sieg/dados/resumo-cliente/:clienteId", asyncHandler(async (req, res) => {
  const cliente = await prisma.cliente.findUnique({ where: { id: String(req.params["clienteId"]) }, select: { cnpj: true } });
  if (!cliente) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  const documento = cliente.cnpj.replace(/\D/g, "");
  const meses = mesesRecentes(3);
  const [empresa, contagens] = await Promise.all([
    prisma.siegEmpresa.findFirst({ where: { documento }, orderBy: { ativo: "desc" } }),
    prisma.siegContagem.findMany({ where: { documento, mes: { in: meses } } }),
  ]);
  const total = (c: (typeof contagens)[number]) => c.nfe + c.nfce + c.cte + c.cfe + c.nfse;
  res.json({
    naSieg: Boolean(empresa),
    empresa: empresa
      ? {
          id: empresa.id,
          ativo: empresa.ativo && !empresa.deletado,
          certificadoExpiraEm: empresa.certificadoExpiraEm,
          consultaNoturna: empresa.consultaNoturna,
          statusSieg: empresa.statusSieg,
        }
      : null,
    meses: meses.map((mes) => {
      const emit = contagens.find((c) => c.mes === mes && c.papel === "emitente");
      const dest = contagens.find((c) => c.mes === mes && c.papel === "destinatario");
      return { mes, emitidas: emit ? total(emit) : null, recebidas: dest ? total(dest) : null };
    }),
  });
}));
