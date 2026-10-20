// Webhook da Evolution API: mensagens que chegam e confirmações de entrega/
// leitura das que o sistema manda. Rota pública (sem autenticação de login)
// — validada pelo token no caminho, combinado com WHATSAPP_WEBHOOK_TOKEN,
// já que a Evolution não devolve o apikey nas chamadas que faz pra nós.
import type { StatusMensagem } from "@prisma/client";
import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { atualizarStatusMensagem, receberMensagem } from "../atendimento/conversas.js";

export const whatsappWebhookRouter = Router();

interface EventoEvolution {
  event?: string;
  data?: unknown;
}

function telefoneDoJid(jid: unknown): string | null {
  if (typeof jid !== "string" || jid.endsWith("@g.us")) {
    return null; // ignora mensagens de grupo
  }
  return jid.split("@")[0] ?? null;
}

function textoDaMensagem(mensagem: unknown): string | null {
  const m = mensagem as Record<string, unknown> | null | undefined;
  const texto =
    m?.conversation ??
    (m?.extendedTextMessage as Record<string, unknown> | undefined)?.text ??
    (m?.imageMessage as Record<string, unknown> | undefined)?.caption ??
    (m?.videoMessage as Record<string, unknown> | undefined)?.caption ??
    null;
  return typeof texto === "string" && texto.trim() ? texto : null;
}

const STATUS_POR_EVENTO: Record<string, StatusMensagem> = {
  DELIVERY_ACK: "ENTREGUE",
  READ: "LIDA",
  PLAYED: "LIDA",
};

async function processarMensagensRecebidas(data: unknown) {
  const itens = Array.isArray(data) ? data : [data];
  for (const item of itens as Record<string, unknown>[]) {
    const key = item?.key as Record<string, unknown> | undefined;
    if (key?.fromMe) continue; // mensagem enviada por nós, já registrada no envio
    const telefone = telefoneDoJid(key?.remoteJid);
    const texto = textoDaMensagem(item?.message);
    if (!telefone || !texto) continue;
    await receberMensagem({
      telefone,
      nomeExibicao: typeof item?.pushName === "string" ? item.pushName : null,
      texto,
      idExterno: typeof key?.id === "string" ? key.id : null,
    });
  }
}

async function processarAtualizacoesDeStatus(data: unknown) {
  const itens = Array.isArray(data) ? data : [data];
  for (const item of itens as Record<string, unknown>[]) {
    const key = item?.key as Record<string, unknown> | undefined;
    const idExterno = (item?.keyId as string | undefined) ?? (key?.id as string | undefined);
    const status = STATUS_POR_EVENTO[item?.status as string];
    if (idExterno && status) {
      await atualizarStatusMensagem(idExterno, status);
    }
  }
}

whatsappWebhookRouter.post(
  "/webhook/whatsapp/:token",
  asyncHandler(async (req, res) => {
    if (!process.env.WHATSAPP_WEBHOOK_TOKEN || req.params.token !== process.env.WHATSAPP_WEBHOOK_TOKEN) {
      res.status(404).end();
      return;
    }
    const { event, data } = (req.body ?? {}) as EventoEvolution;
    try {
      if (event === "messages.upsert") {
        await processarMensagensRecebidas(data);
      } else if (event === "messages.update") {
        await processarAtualizacoesDeStatus(data);
      }
    } catch (error) {
      console.error("[whatsapp:webhook]", error);
    }
    res.status(200).end();
  })
);
