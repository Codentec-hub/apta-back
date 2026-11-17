// Cria notificações respeitando a preferência de cada usuário, avisa as telas
// abertas na hora (SSE) e manda e-mail quando o usuário pediu. Nunca lança:
// um aviso que falha não pode derrubar a ação que o gerou.
import { assinatura, escritorio } from "../escritorio.js";
import { emailConfigurado, enviarEmail } from "../envio/email.js";
import { emitirEvento } from "../eventos.js";
import { prismaBase as prisma } from "../prisma.js";
import { TIPOS_NOTIFICACAO, type Severidade, type TipoId } from "./tipos.js";

export interface NovaNotificacao {
  tipo: TipoId;
  titulo: string;
  mensagem: string;
  href?: string | null;
  severidade?: Severidade;
  /** Mesma chave para o mesmo usuário = não repete. */
  chave?: string | null;
  dados?: Record<string, unknown>;
}

const escapar = (t: string) =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Gestores e administradores ativos. */
export async function idsDaGestao(): Promise<string[]> {
  const u = await prisma.usuario.findMany({ where: { ativo: true, perfil: { in: ["ADMIN", "GESTOR"] } }, select: { id: true } });
  return u.map((x) => x.id);
}

export async function notificar(usuarioIds: (string | null | undefined)[], n: NovaNotificacao): Promise<number> {
  try {
    const def = TIPOS_NOTIFICACAO[n.tipo];
    let ids = [...new Set(usuarioIds.filter((x): x is string => Boolean(x)))];
    if (!ids.length) return 0;

    const usuarios = await prisma.usuario.findMany({
      where: { id: { in: ids }, ativo: true, ...("gestao" in def && def.gestao ? { perfil: { in: ["ADMIN", "GESTOR"] } } : {}) },
      select: { id: true, nome: true, email: true, preferenciasNotificacao: { where: { tipo: n.tipo } } },
    });
    const querApp = usuarios.filter((u) => u.preferenciasNotificacao[0]?.app ?? def.padrao.app);
    const querEmail = new Set(
      usuarios.filter((u) => u.preferenciasNotificacao[0]?.email ?? def.padrao.email).map((u) => u.id),
    );
    ids = querApp.map((u) => u.id);
    if (!ids.length) return 0;

    const criadas = await prisma.notificacao.createManyAndReturn({
      data: ids.map((usuarioId) => ({
        usuarioId,
        tipo: n.tipo,
        categoria: def.categoria,
        severidade: n.severidade ?? "info",
        titulo: n.titulo.slice(0, 200),
        mensagem: n.mensagem.slice(0, 1000),
        href: n.href ?? null,
        chave: n.chave ?? null,
        dados: (n.dados ?? undefined) as never,
      })),
      skipDuplicates: true,
      select: { id: true, usuarioId: true },
    });

    for (const c of criadas) emitirEvento({ tipo: "notificacao", usuarioId: c.usuarioId });

    if (emailConfigurado()) {
      const porId = new Map(usuarios.map((u) => [u.id, u]));
      const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
      for (const c of criadas) {
        const u = porId.get(c.usuarioId);
        if (!u || !querEmail.has(u.id) || !u.email) continue;
        const link = n.href ? `${base}${n.href}` : `${base}/dashboard/notificacoes`;
        enviarEmail({
          para: u.email,
          assunto: `${n.titulo} · ${escritorio().nome}`,
          texto: `Olá, ${u.nome.split(" ")[0]}!\n\n${n.mensagem}\n\nAbrir no sistema: ${link}\n\n${assinatura()}\n(Para não receber este aviso por e-mail, ajuste em Notificações → Preferências.)`,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;line-height:1.5"><p>Olá, ${escapar(u.nome.split(" ")[0] ?? "")}!</p><p style="font-size:16px"><strong>${escapar(n.titulo)}</strong></p><p>${escapar(n.mensagem)}</p><p><a href="${escapar(link)}" style="display:inline-block;background:#1e3a5f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Abrir no sistema</a></p><p style="color:#6b7280;font-size:12px;margin-top:24px">${escapar(assinatura())} · Para não receber este aviso por e-mail, ajuste em Notificações → Preferências.</p></div>`,
        })
          .then(() => prisma.notificacao.update({ where: { id: c.id }, data: { emailEnviadoEm: new Date() } }))
          .catch((error) => console.error("[notificacoes] e-mail não enviado", error));
      }
    }
    return criadas.length;
  } catch (error) {
    console.error("[notificacoes] falha ao notificar", n.tipo, error);
    return 0;
  }
}
