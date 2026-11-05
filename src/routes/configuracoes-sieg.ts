// Configuração das credenciais de sistema do SIEG (client_id/secret_key do
// integrador "Apta") e diagnóstico de conexão. Separado de
// configuracoes-integracao.ts porque o SIEG vai crescer bastante nas
// próximas fases (onboarding por cliente, sincronização de XMLs).
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";
import { completarTodos } from "../clientes/completar.js";
import { credenciaisConfiguradas, invalidarCache, obterTokenSistema } from "../sieg/auth.js";
import { empresasSiegGravadas, estadoEmpresasSieg, iniciarSincronizacaoEmpresas } from "../sieg/empresas.js";

export const configuracoesSiegRouter = Router();

configuracoesSiegRouter.use("/configuracoes/sieg", autenticar);

function podeAlterar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

function mascarar(valor: string | null): string | null {
  if (!valor) return null;
  return valor.length <= 4 ? "••••" : `••••••••${valor.slice(-4)}`;
}

configuracoesSiegRouter.get("/configuracoes/sieg", asyncHandler(async (_req, res) => {
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  const clientId = config?.clientId || process.env.SIEG_CLIENT_ID || null;
  const secretKey = config?.secretKey || process.env.SIEG_SECRET_KEY || null;
  const oauthValido = Boolean(config?.oauthToken && config.oauthExpiraEm && config.oauthExpiraEm > new Date());
  res.json({
    clientIdConfigurado: Boolean(clientId),
    secretKeyMascarada: mascarar(secretKey),
    origem: config?.clientId ? "banco" : process.env.SIEG_CLIENT_ID ? "ambiente" : "nenhuma",
    oauthAutorizado: oauthValido,
    oauthExpiraEm: oauthValido ? config!.oauthExpiraEm : null,
  });
}));

const siegSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  secretKey: z.string().trim().min(1).optional(),
});

configuracoesSiegRouter.put("/configuracoes/sieg", asyncHandler(async (req, res) => {
  if (!podeAlterar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar esta configuração" });
    return;
  }
  const parsed = siegSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  await prisma.configuracaoSieg.upsert({
    where: { id: 1 },
    create: { id: 1, ...parsed.data },
    update: parsed.data,
  });
  invalidarCache();
  res.status(204).send();
}));

// Tenta de fato autenticar no SIEG com as credenciais atuais — é o que o
// botão "Testar conexão" da tela de Integrações chama.
configuracoesSiegRouter.get("/configuracoes/sieg/status", asyncHandler(async (_req, res) => {
  if (!(await credenciaisConfiguradas())) {
    res.json({ ok: false, erro: "Credenciais não configuradas" });
    return;
  }
  try {
    await obterTokenSistema();
    res.json({ ok: true });
  } catch (error) {
    res.json({ ok: false, erro: error instanceof Error ? error.message : String(error) });
  }
}));

// Empresas/certificados da conta SIEG, lidos do banco (sieg_empresas) e
// cruzados com os clientes da Apta pelo CNPJ/CPF. A busca na SIEG roda em
// segundo plano (ver sieg/empresas.ts) e grava no banco.
async function respostaEmpresas() {
  const estado = estadoEmpresasSieg();
  const [gravadas, clientes] = await Promise.all([
    empresasSiegGravadas(),
    prisma.cliente.findMany({ select: { id: true, razaoSocial: true, nomeFantasia: true, cnpj: true, ativo: true } }),
  ]);
  const porDocumento = new Map(clientes.map((c) => [c.cnpj.replace(/\D/g, ""), c]));
  const empresas = gravadas.map((e) => {
    const cliente = porDocumento.get(e.documento);
    return {
      ...e,
      cliente: cliente ? { id: cliente.id, nome: cliente.nomeFantasia || cliente.razaoSocial, ativo: cliente.ativo } : null,
    };
  });
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  // Sem busca nesta execução do servidor, mas com dados gravados: mostra como concluída.
  const situacao =
    estado.situacao === "nunca" && gravadas.length > 0 ? { ...estado, situacao: "concluida" as const } : estado;
  return {
    ...situacao,
    concluidaEm:
      situacao.concluidaEm ??
      config?.ultimaSincronizacaoEm?.toISOString() ??
      (await prisma.siegEmpresa.findFirst({ orderBy: { atualizadoEm: "desc" }, select: { atualizadoEm: true } }))
        ?.atualizadoEm.toISOString() ??
      null,
    configurado: await credenciaisConfiguradas(),
    empresas,
    totalClientesAtivos: clientes.filter((c) => c.ativo).length,
  };
}

configuracoesSiegRouter.get("/configuracoes/sieg/empresas", asyncHandler(async (_req, res) => {
  // Banco vazio (primeira vez): já dispara a busca.
  if (
    estadoEmpresasSieg().situacao === "nunca" &&
    (await prisma.siegEmpresa.count()) === 0 &&
    (await credenciaisConfiguradas())
  ) {
    iniciarSincronizacaoEmpresas();
  }
  res.json(await respostaEmpresas());
}));

configuracoesSiegRouter.post("/configuracoes/sieg/empresas/atualizar", asyncHandler(async (_req, res) => {
  if (!(await credenciaisConfiguradas())) {
    res.status(400).json({ erro: "Credenciais do SIEG não configuradas" });
    return;
  }
  iniciarSincronizacaoEmpresas();
  res.json(await respostaEmpresas());
}));

// ---------------------------------------------------------------------------
// Usar a lista da SIEG como base de clientes (ação pontual do administrador).
//
// Regra combinada em 04/11/2026: neste momento a base de clientes da Apta
// passa a ser exatamente as empresas ATIVAS na SIEG; os clientes fictícios
// (que não estão na SIEG) podem ser apagados. A SIEG nunca é alterada: aqui só
// LEMOS dela (acesso OAuth "read"). Clientes cadastrados depois pelo sistema
// ficam só no banco da Apta.
// ---------------------------------------------------------------------------

// Código IBGE da UF (o SIEG devolve número) -> sigla.
const UF_IBGE: Record<number, string> = {
  11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO", 21: "MA", 22: "PI", 23: "CE",
  24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP",
  41: "PR", 42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF",
};

function ehAdmin(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN";
}

async function planoClientesSieg() {
  if (estadoEmpresasSieg().situacao === "andamento") return null;
  const gravadas = await empresasSiegGravadas();
  if (gravadas.length === 0) return null;
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });

  const ativas = new Map<string, (typeof gravadas)[number]>();
  for (const e of gravadas) {
    if (e.ativo && !e.deletado && (e.documento.length === 11 || e.documento.length === 14) && !ativas.has(e.documento))
      ativas.set(e.documento, e);
  }
  const clientes = await prisma.cliente.findMany({
    select: {
      id: true,
      razaoSocial: true,
      nomeFantasia: true,
      cnpj: true,
      _count: { select: { obrigacoes: true, demandas: true, contatos: true } },
    },
  });
  const porDocumento = new Map(clientes.map((c) => [c.cnpj.replace(/\D/g, ""), c]));

  const criar = [...ativas.values()]
    .filter((e) => !porDocumento.has(e.documento))
    .map((e) => ({ documento: e.documento, nome: e.nome, uf: e.ufCertificado ? (UF_IBGE[e.ufCertificado] ?? null) : null }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const manter = clientes.filter((c) => ativas.has(c.cnpj.replace(/\D/g, "")));
  const apagar = clientes
    .filter((c) => !ativas.has(c.cnpj.replace(/\D/g, "")))
    .map((c) => ({
      id: c.id,
      nome: c.nomeFantasia || c.razaoSocial,
      documento: c.cnpj,
      obrigacoes: c._count.obrigacoes,
      demandas: c._count.demandas,
      contatos: c._count.contatos,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  return {
    lidaEm: estadoEmpresasSieg().concluidaEm ?? config?.ultimaSincronizacaoEm?.toISOString() ?? null,
    totalAtivasSieg: ativas.size,
    criar,
    manter: manter.length,
    apagar,
  };
}

configuracoesSiegRouter.get("/configuracoes/sieg/clientes/previa", asyncHandler(async (req, res) => {
  if (!ehAdmin(req)) {
    res.status(403).json({ erro: "Apenas administradores podem usar a lista da SIEG como base de clientes" });
    return;
  }
  const plano = await planoClientesSieg();
  if (!plano) {
    res.status(409).json({ erro: "Atualize a lista da SIEG (e espere concluir) antes de importar os clientes" });
    return;
  }
  res.json(plano);
}));

const aplicarSchema = z.object({
  apagarForaDaSieg: z.boolean(),
  // O front manda quantos clientes a pessoa viu na prévia para apagar; se o
  // número mudou (alguém cadastrou um cliente no meio), não apaga nada.
  quantidadeApagarConfirmada: z.number().int().min(0),
});

configuracoesSiegRouter.post("/configuracoes/sieg/clientes/aplicar", asyncHandler(async (req, res) => {
  if (!ehAdmin(req)) {
    res.status(403).json({ erro: "Apenas administradores podem usar a lista da SIEG como base de clientes" });
    return;
  }
  const parsed = aplicarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Dados inválidos para a importação" });
    return;
  }
  const plano = await planoClientesSieg();
  if (!plano) {
    res.status(409).json({ erro: "Atualize a lista da SIEG (e espere concluir) antes de importar os clientes" });
    return;
  }
  if (parsed.data.apagarForaDaSieg && parsed.data.quantidadeApagarConfirmada !== plano.apagar.length) {
    res.status(409).json({
      erro: `A lista de clientes mudou desde a prévia (agora seriam ${plano.apagar.length} para apagar). Abra a prévia de novo e confira antes de confirmar.`,
    });
    return;
  }

  const resultado = await prisma.$transaction(async (tx) => {
    let apagados = 0;
    if (parsed.data.apagarForaDaSieg && plano.apagar.length > 0) {
      const r = await tx.cliente.deleteMany({ where: { id: { in: plano.apagar.map((c) => c.id) } } });
      apagados = r.count;
    }
    const r = await tx.cliente.createMany({
      data: plano.criar.map((e) => ({ razaoSocial: e.nome || e.documento, cnpj: e.documento, uf: e.uf, ativo: true })),
      skipDuplicates: true,
    });
    return { apagados, criados: r.count };
  });

  console.log(
    `[sieg] clientes importados por ${req.usuario?.usuarioId}: ${resultado.criados} criados, ${resultado.apagados} apagados, ${plano.manter} mantidos`,
  );
  // Os clientes novos chegam só com nome e CNPJ: completa o cadastro sozinho.
  if (resultado.criados > 0) void completarTodos().catch((e) => console.error("[clientes] falha ao completar cadastros", e));
  res.json({ ...resultado, mantidos: plano.manter });
}));
