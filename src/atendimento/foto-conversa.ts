// Foto de perfil do WhatsApp do cliente. A URL que o WhatsApp devolve expira
// em poucos dias, então a imagem é baixada e guardada (fotos_conversa) e
// consultada de novo no máximo 1x por dia por conversa.
import { emitirEvento } from "../eventos.js";
import { prismaBase } from "../prisma.js";
import { provedorWhatsApp } from "../whatsapp/provedor.js";

const VALIDADE_MS = 24 * 60 * 60 * 1000;
const TAMANHO_MAX = 1024 * 1024;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

const emAndamento = new Set<string>();

async function baixarImagem(url: string): Promise<{ dados: Uint8Array<ArrayBuffer>; mime: string } | null> {
  const resposta = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resposta.ok) return null;
  const mime = (resposta.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!MIMES.has(mime)) return null;
  const dados = new Uint8Array(await resposta.arrayBuffer());
  if (dados.length === 0 || dados.length > TAMANHO_MAX) return null;
  return { dados, mime };
}

async function atualizar(conversaId: string, telefone: string): Promise<void> {
  const provedor = provedorWhatsApp();
  if (!provedor.buscarFotoPerfil) return;
  const url = await provedor.buscarFotoPerfil(telefone);
  const imagem = url ? await baixarImagem(url) : null;
  const antes = await prismaBase.conversa.findUnique({ where: { id: conversaId }, select: { fotoEm: true } });
  if (imagem) {
    await prismaBase.fotoConversa.upsert({
      where: { conversaId },
      create: { conversaId, ...imagem },
      update: imagem,
    });
    await prismaBase.conversa.update({ where: { id: conversaId }, data: { fotoEm: new Date(), fotoBuscadaEm: new Date() } });
  } else {
    // Sem foto (ou escondida pela privacidade): some daqui também.
    await prismaBase.fotoConversa.deleteMany({ where: { conversaId } });
    await prismaBase.conversa.update({ where: { id: conversaId }, data: { fotoEm: null, fotoBuscadaEm: new Date() } });
    if (!antes?.fotoEm) return;
  }
  emitirEvento({ tipo: "conversa", conversaId });
}

/** Atualiza em segundo plano as fotos que nunca foram buscadas ou já passaram de 1 dia. */
export function atualizarFotosVencidas(
  conversas: { id: string; telefone: string | null; canal: string; fotoBuscadaEm: Date | null }[],
  limite = 15,
): void {
  if (!provedorWhatsApp().buscarFotoPerfil) return;
  const agora = Date.now();
  const fila = conversas
    .filter(
      (c) =>
        c.telefone &&
        c.canal === "whatsapp" &&
        !emAndamento.has(c.id) &&
        (!c.fotoBuscadaEm || agora - c.fotoBuscadaEm.getTime() > VALIDADE_MS),
    )
    .slice(0, limite);
  if (fila.length === 0) return;
  for (const c of fila) emAndamento.add(c.id);
  void (async () => {
    for (const c of fila) {
      try {
        await atualizar(c.id, c.telefone!);
      } catch (error) {
        console.error("[foto-conversa]", error instanceof Error ? error.message : error);
        // Provedor fora do ar: tenta de novo daqui a 1 hora, não a cada lista.
        await prismaBase.conversa
          .update({ where: { id: c.id }, data: { fotoBuscadaEm: new Date(Date.now() - VALIDADE_MS + 60 * 60 * 1000) } })
          .catch(() => {});
      } finally {
        emAndamento.delete(c.id);
      }
    }
  })();
}
