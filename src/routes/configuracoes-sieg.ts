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
import { credenciaisConfiguradas, invalidarCache, obterTokenSistema } from "../sieg/auth.js";
import { estadoEmpresasSieg, iniciarSincronizacaoEmpresas } from "../sieg/empresas.js";

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

// Empresas/certificados cadastrados na conta SIEG (GET /api/v1/listar),
// cruzadas com os clientes da Apta pelo CNPJ/CPF. A busca no SIEG roda em
// segundo plano (ver sieg/empresas.ts); aqui só devolvemos o que já veio.
async function respostaEmpresas() {
  const estado = estadoEmpresasSieg();
  const clientes = await prisma.cliente.findMany({
    select: { id: true, razaoSocial: true, nomeFantasia: true, cnpj: true, ativo: true },
  });
  const porDocumento = new Map(clientes.map((c) => [c.cnpj.replace(/\D/g, ""), c]));
  // Só certificados em uso contam: excluídos/inativos na SIEG não capturam notas.
  const documentosSieg = new Set(estado.empresas.filter((e) => e.ativo && !e.deletado).map((e) => e.documento));

  const empresas = estado.empresas
    .map((e) => {
      const cliente = porDocumento.get(e.documento);
      return {
        ...e,
        cliente: cliente
          ? { id: cliente.id, nome: cliente.nomeFantasia || cliente.razaoSocial, ativo: cliente.ativo }
          : null,
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  const clientesSemSieg =
    estado.situacao === "concluida"
      ? clientes
          .filter((c) => c.ativo && !documentosSieg.has(c.cnpj.replace(/\D/g, "")))
          .map((c) => ({ id: c.id, nome: c.nomeFantasia || c.razaoSocial, documento: c.cnpj.replace(/\D/g, "") }))
          .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
      : [];

  const { empresas: _ignorar, ...situacao } = estado;
  return {
    ...situacao,
    configurado: await credenciaisConfiguradas(),
    empresas,
    clientesSemSieg,
    totalClientesAtivos: clientes.filter((c) => c.ativo).length,
  };
}

configuracoesSiegRouter.get("/configuracoes/sieg/empresas", asyncHandler(async (_req, res) => {
  // Primeira visita depois de um restart: já dispara a busca.
  if (estadoEmpresasSieg().situacao === "nunca" && (await credenciaisConfiguradas())) {
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
