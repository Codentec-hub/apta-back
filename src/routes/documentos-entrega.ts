// Documentos da entrega + protocolo de entrega (modelo Acessórias): o
// analista anexa a guia/declaração, gera um protocolo para cada contato do
// cliente que recebe aquele departamento, e o sistema registra quando o
// cliente abre o documento ("Docs lidos / não lidos").
//
// Envio automático por e-mail/WhatsApp depende de integração externa e ainda
// não existe: o protocolo nasce "Aguardando envio" com um link público, que o
// analista manda pelo canal que já usa e marca como enviado.
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import express, { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
const LIMITE_ARQUIVO = "25mb";

async function registrarLog(obrigacaoId: string, usuarioId: string | null, acao: string, detalhe: string): Promise<void> {
  await prisma.logObrigacao.create({ data: { obrigacaoId, acao, detalhe, usuarioId } });
}

function nomeSeguro(nome: string): string {
  return nome.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").slice(-120) || "arquivo";
}

function enviarArquivo(res: Response, doc: { caminho: string; mimeType: string; nomeArquivo: string }, download: boolean): void {
  const absoluto = path.resolve(UPLOAD_DIR, doc.caminho);
  if (!absoluto.startsWith(UPLOAD_DIR + path.sep)) {
    res.status(400).json({ erro: "Caminho inválido" });
    return;
  }
  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(doc.nomeArquivo)}`
  );
  createReadStream(absoluto)
    .on("error", () => {
      if (!res.headersSent) res.status(404).json({ erro: "Arquivo não encontrado no servidor" });
      else res.end();
    })
    .pipe(res);
}

const protocoloSelect = {
  id: true,
  numero: true,
  token: true,
  destinatarioNome: true,
  destinatarioEmail: true,
  destinatarioCelular: true,
  status: true,
  canal: true,
  erroEnvio: true,
  enviadoEm: true,
  lidoEm: true,
  acessos: true,
  createdAt: true,
  contatoId: true,
  usuario: { select: { id: true, nome: true } },
} as const;

const documentoSelect = {
  id: true,
  nomeArquivo: true,
  mimeType: true,
  tamanho: true,
  createdAt: true,
  usuario: { select: { id: true, nome: true } },
} as const;

// ---------------------------------------------------------------------------
// Rotas públicas (o cliente abre o link sem login). Precisam ser montadas
// ANTES dos routers que aplicam `autenticar` a tudo que passa por eles.
// ---------------------------------------------------------------------------
export const entregaPublicaRouter = Router();

async function protocoloPorToken(token: string) {
  return prisma.protocoloEntrega.findUnique({
    where: { token },
    include: {
      obrigacao: {
        select: {
          id: true,
          nome: true,
          competencia: true,
          prazo: true,
          concluidaEm: true,
          tipo: { select: { competenciaReferente: true } },
          cliente: { select: { razaoSocial: true, cnpj: true } },
          documentos: { select: documentoSelect, orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
}

entregaPublicaRouter.get("/publico/entregas/:token", asyncHandler(async (req, res) => {
  const protocolo = await protocoloPorToken(req.params.token);
  if (!protocolo) {
    res.status(404).json({ erro: "Link inválido ou expirado" });
    return;
  }
  await prisma.protocoloEntrega.update({ where: { id: protocolo.id }, data: { acessos: { increment: 1 } } });
  const { obrigacao } = protocolo;
  res.json({
    numero: protocolo.numero,
    destinatarioNome: protocolo.destinatarioNome,
    lidoEm: protocolo.lidoEm,
    createdAt: protocolo.createdAt,
    empresa: obrigacao.cliente,
    obrigacao: {
      nome: obrigacao.nome,
      competencia: obrigacao.competencia,
      competenciaAnual: Math.abs(obrigacao.tipo?.competenciaReferente ?? 0) === 12,
      prazo: obrigacao.prazo,
      entregueEm: obrigacao.concluidaEm,
    },
    documentos: obrigacao.documentos.map(({ usuario: _usuario, ...d }) => d),
  });
}));

// Abrir/baixar o documento é o que conta como "lido".
entregaPublicaRouter.get("/publico/entregas/:token/documentos/:docId", asyncHandler(async (req, res) => {
  const protocolo = await prisma.protocoloEntrega.findUnique({ where: { token: req.params.token } });
  if (!protocolo) {
    res.status(404).json({ erro: "Link inválido ou expirado" });
    return;
  }
  const doc = await prisma.documentoEntrega.findFirst({
    where: { id: req.params.docId, obrigacaoId: protocolo.obrigacaoId },
  });
  if (!doc) {
    res.status(404).json({ erro: "Documento não encontrado" });
    return;
  }
  if (!protocolo.lidoEm) {
    await prisma.protocoloEntrega.update({ where: { id: protocolo.id }, data: { lidoEm: new Date() } });
    await registrarLog(
      protocolo.obrigacaoId,
      null,
      "documento_lido",
      `Protocolo nº ${protocolo.numero}: ${protocolo.destinatarioNome} abriu os documentos`
    );
  }
  enviarArquivo(res, doc, req.query.download === "1");
}));

// ---------------------------------------------------------------------------
// Rotas internas (analistas)
// ---------------------------------------------------------------------------
export const documentosEntregaRouter = Router();

documentosEntregaRouter.use(autenticar);

documentosEntregaRouter.get("/obrigacoes/:id/documentos", asyncHandler(async (req, res) => {
  const obrigacao = await prisma.obrigacao.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      documentos: { select: documentoSelect, orderBy: { createdAt: "asc" } },
      protocolos: { select: protocoloSelect, orderBy: { numero: "asc" } },
    },
  });
  if (!obrigacao) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }
  res.json({ documentos: obrigacao.documentos, protocolos: obrigacao.protocolos });
}));

// Upload do arquivo cru no corpo (sem multipart): nome no cabeçalho
// X-Nome-Arquivo (URI-encoded), tipo no Content-Type.
documentosEntregaRouter.post(
  "/obrigacoes/:id/documentos",
  express.raw({ type: () => true, limit: LIMITE_ARQUIVO }),
  asyncHandler(async (req: Request, res: Response) => {
    const obrigacao = await prisma.obrigacao.findUnique({ where: { id: req.params.id } });
    if (!obrigacao) {
      res.status(404).json({ erro: "Obrigação não encontrada" });
      return;
    }
    const corpo = req.body as unknown;
    if (!Buffer.isBuffer(corpo) || corpo.length === 0) {
      res.status(400).json({ erro: "Envie o arquivo no corpo da requisição" });
      return;
    }
    let nomeArquivo = "documento";
    try {
      nomeArquivo = decodeURIComponent(String(req.headers["x-nome-arquivo"] ?? "documento")).trim() || "documento";
    } catch {
      // nome mal codificado: fica o padrão
    }
    const mimeType = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0];

    const relativo = path.join(obrigacao.id, `${randomUUID()}-${nomeSeguro(nomeArquivo)}`);
    await mkdir(path.join(UPLOAD_DIR, obrigacao.id), { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, relativo), corpo);

    const documento = await prisma.documentoEntrega.create({
      data: {
        nomeArquivo,
        mimeType,
        tamanho: corpo.length,
        caminho: relativo,
        obrigacaoId: obrigacao.id,
        usuarioId: req.usuario?.usuarioId ?? null,
      },
      select: documentoSelect,
    });
    await registrarLog(obrigacao.id, req.usuario?.usuarioId ?? null, "documento_anexado", `Documento anexado: ${nomeArquivo}`);
    res.status(201).json(documento);
  })
);

documentosEntregaRouter.get("/documentos/:id/arquivo", asyncHandler(async (req, res) => {
  const doc = await prisma.documentoEntrega.findUnique({ where: { id: req.params.id } });
  if (!doc) {
    res.status(404).json({ erro: "Documento não encontrado" });
    return;
  }
  enviarArquivo(res, doc, req.query.download === "1");
}));

documentosEntregaRouter.delete("/documentos/:id", asyncHandler(async (req, res) => {
  const doc = await prisma.documentoEntrega.findUnique({ where: { id: req.params.id } });
  if (!doc) {
    res.status(404).json({ erro: "Documento não encontrado" });
    return;
  }
  await prisma.documentoEntrega.delete({ where: { id: doc.id } });
  await unlink(path.resolve(UPLOAD_DIR, doc.caminho)).catch(() => null);
  await registrarLog(doc.obrigacaoId, req.usuario?.usuarioId ?? null, "documento_removido", `Documento removido: ${doc.nomeArquivo}`);
  res.status(204).send();
}));

// Gera um protocolo por contato escolhido (e/ou um destinatário avulso).
const protocolosSchema = z
  .object({
    contatoIds: z.array(z.string().uuid()).default([]),
    avulso: z
      .object({
        nome: z.string().trim().min(1),
        email: z.string().trim().email().optional().nullable().or(z.literal("").transform(() => null)),
        celular: z.string().trim().optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .refine((d) => d.contatoIds.length > 0 || d.avulso, "Escolha ao menos um destinatário");

documentosEntregaRouter.post("/obrigacoes/:id/protocolos", asyncHandler(async (req, res) => {
  const parsed = protocolosSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Escolha ao menos um destinatário" });
    return;
  }
  const obrigacao = await prisma.obrigacao.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { documentos: true } } },
  });
  if (!obrigacao) {
    res.status(404).json({ erro: "Obrigação não encontrada" });
    return;
  }
  if (obrigacao._count.documentos === 0) {
    res.status(400).json({ erro: "Anexe ao menos um documento antes de gerar o protocolo" });
    return;
  }

  const contatos = await prisma.contatoCliente.findMany({
    where: { id: { in: parsed.data.contatoIds }, clienteId: obrigacao.clienteId, ativo: true },
  });
  const destinatarios = [
    ...contatos.map((c) => ({ contatoId: c.id, nome: c.nome, email: c.email, celular: c.celular })),
    ...(parsed.data.avulso
      ? [{ contatoId: null, nome: parsed.data.avulso.nome, email: parsed.data.avulso.email ?? null, celular: parsed.data.avulso.celular ?? null }]
      : []),
  ];

  const usuarioId = req.usuario?.usuarioId ?? null;
  const criados = [];
  for (const d of destinatarios) {
    const protocolo = await prisma.protocoloEntrega.create({
      data: {
        token: randomBytes(24).toString("base64url"),
        destinatarioNome: d.nome,
        destinatarioEmail: d.email,
        destinatarioCelular: d.celular,
        canal: "link",
        obrigacaoId: obrigacao.id,
        contatoId: d.contatoId,
        usuarioId,
      },
      select: protocoloSelect,
    });
    criados.push(protocolo);
  }
  await registrarLog(
    obrigacao.id,
    usuarioId,
    "protocolo_gerado",
    `Protocolo(s) ${criados.map((p) => `nº ${p.numero}`).join(", ")} para ${criados.map((p) => p.destinatarioNome).join(", ")}`
  );
  res.status(201).json(criados);
}));

// O analista confirma que mandou o link (WhatsApp/e-mail manual). Com a
// integração de envio, isso passa a ser feito pelo próprio disparo.
documentosEntregaRouter.post("/protocolos/:id/enviado", asyncHandler(async (req, res) => {
  const parsed = z.object({ canal: z.enum(["link", "email", "whatsapp", "app"]).default("link") }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const existente = await prisma.protocoloEntrega.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Protocolo não encontrado" });
    return;
  }
  const protocolo = await prisma.protocoloEntrega.update({
    where: { id: existente.id },
    data: { status: "ENVIADO", canal: parsed.data.canal, enviadoEm: existente.enviadoEm ?? new Date(), erroEnvio: null },
    select: protocoloSelect,
  });
  await registrarLog(
    existente.obrigacaoId,
    req.usuario?.usuarioId ?? null,
    "protocolo_enviado",
    `Protocolo nº ${protocolo.numero} enviado a ${protocolo.destinatarioNome} (${parsed.data.canal})`
  );
  res.json(protocolo);
}));

documentosEntregaRouter.delete("/protocolos/:id", asyncHandler(async (req, res) => {
  const existente = await prisma.protocoloEntrega.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Protocolo não encontrado" });
    return;
  }
  await prisma.protocoloEntrega.delete({ where: { id: existente.id } });
  await registrarLog(
    existente.obrigacaoId,
    req.usuario?.usuarioId ?? null,
    "protocolo_cancelado",
    `Protocolo nº ${existente.numero} (${existente.destinatarioNome}) cancelado — o link deixou de funcionar`
  );
  res.status(204).send();
}));
