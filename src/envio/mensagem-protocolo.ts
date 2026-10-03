// Texto do e-mail que leva o protocolo de entrega ao cliente. O e-mail traz
// o link do protocolo, e não o anexo: é a abertura pelo link que marca o
// documento como lido ("Docs lidos / não lidos").
import type { Email } from "./email.js";

export interface DadosMensagemProtocolo {
  numero: number;
  token: string;
  destinatarioNome: string;
  destinatarioEmail: string;
  obrigacao: {
    nome: string;
    competencia: Date | null;
    competenciaAnual: boolean;
    prazo: Date;
  };
  empresa: { razaoSocial: string };
  documentos: string[];
  analista: { nome: string; email: string } | null;
}

// Link da página pública /entrega/<token> no front.
export function linkPublico(token: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/entrega/${token}`;
}

function escapar(texto: string): string {
  return texto
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Competência é @db.Date (meia-noite UTC); prazo é fim do dia no horário local.
function formatarCompetencia(competencia: Date | null, anual: boolean): string | null {
  if (!competencia) return null;
  const opcoes: Intl.DateTimeFormatOptions = anual
    ? { year: "numeric", timeZone: "UTC" }
    : { month: "2-digit", year: "numeric", timeZone: "UTC" };
  return competencia.toLocaleDateString("pt-BR", opcoes);
}

function formatarData(data: Date): string {
  return data.toLocaleDateString("pt-BR", { timeZone: process.env.TZ_ESCRITORIO ?? "America/Fortaleza" });
}

// Lembrete de guia não lida (Acessórias: "[Guia não visualizada]").
export interface Lembrete {
  diasRestantes: number;
  prefixo: string;
  aviso: string | null;
}

function quandoVence(dias: number): string {
  if (dias <= 0) return "vence hoje";
  if (dias === 1) return "vence amanhã";
  return `vence em ${dias} dias`;
}

export function mensagemProtocolo(d: DadosMensagemProtocolo, lembrete?: Lembrete): Email {
  const link = linkPublico(d.token);
  const primeiroNome = d.destinatarioNome.trim().split(/\s+/)[0] ?? d.destinatarioNome;
  const competencia = formatarCompetencia(d.obrigacao.competencia, d.obrigacao.competenciaAnual);
  const detalhes = [
    competencia ? `Competência: ${competencia}` : null,
    `Vencimento: ${formatarData(d.obrigacao.prazo)}`,
    `Protocolo nº ${d.numero}`,
  ].filter((linha): linha is string => linha !== null);

  const assuntoBase = `${d.obrigacao.nome}${competencia ? ` ${competencia}` : ""} — ${d.empresa.razaoSocial}`;
  const assunto = lembrete ? `${lembrete.prefixo.trim()} ${assuntoBase}`.trim() : assuntoBase;
  const abertura = lembrete
    ? `Ainda não identificamos a abertura de ${d.obrigacao.nome} da empresa ${d.empresa.razaoSocial}, que ${quandoVence(lembrete.diasRestantes)}.`
    : `A Apta Contabilidade disponibilizou ${d.obrigacao.nome} da empresa ${d.empresa.razaoSocial}.`;
  const aviso = lembrete?.aviso?.trim() || null;

  const texto = [
    ...(aviso ? [aviso, ""] : []),
    `Olá, ${primeiroNome}!`,
    "",
    abertura,
    "",
    ...detalhes,
    "",
    `Documentos: ${d.documentos.join(", ")}`,
    "",
    `Acesse pelo link: ${link}`,
    "",
    d.analista ? `Dúvidas? Responda este e-mail para falar com ${d.analista.nome}.` : "Dúvidas? Fale com a Apta Contabilidade.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px">
    <tr><td style="padding:24px 28px;border-bottom:1px solid #e5e7eb">
      <strong style="font-size:18px;color:#1e3a5f">Apta Contabilidade</strong>
    </td></tr>
    <tr><td style="padding:28px">${
      aviso
        ? `
      <p style="margin:0 0 20px;padding:12px 16px;background:#fff7ed;border-left:4px solid #ea580c;color:#7c2d12;font-size:14px">${escapar(aviso)}</p>`
        : ""
    }
      <p style="margin:0 0 16px">Olá, ${escapar(primeiroNome)}!</p>
      <p style="margin:0 0 16px">${
        lembrete
          ? `Ainda não identificamos a abertura de <strong>${escapar(d.obrigacao.nome)}</strong> da empresa <strong>${escapar(d.empresa.razaoSocial)}</strong>, que <strong>${quandoVence(lembrete.diasRestantes)}</strong>.`
          : `A Apta Contabilidade disponibilizou <strong>${escapar(d.obrigacao.nome)}</strong> da empresa <strong>${escapar(d.empresa.razaoSocial)}</strong>.`
      }</p>
      <p style="margin:0 0 16px;color:#4b5563;font-size:14px;line-height:1.6">${detalhes.map(escapar).join("<br>")}</p>
      <p style="margin:0 0 8px;font-size:14px">Documentos:</p>
      <ul style="margin:0 0 24px;padding-left:20px;font-size:14px">${d.documentos.map((nome) => `<li>${escapar(nome)}</li>`).join("")}</ul>
      <p style="margin:0 0 24px;text-align:center">
        <a href="${escapar(link)}" style="display:inline-block;padding:12px 28px;background:#1e3a5f;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">Abrir documentos</a>
      </p>
      <p style="margin:0;font-size:12px;color:#6b7280">Se o botão não funcionar, copie este endereço no navegador:<br><a href="${escapar(link)}" style="color:#1e3a5f;word-break:break-all">${escapar(link)}</a></p>
    </td></tr>
    <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
      ${d.analista ? `Dúvidas? Responda este e-mail para falar com ${escapar(d.analista.nome)}.` : "Dúvidas? Fale com a Apta Contabilidade."}
    </td></tr>
  </table>
</body>
</html>`;

  return { para: d.destinatarioEmail, assunto, html, texto, responderPara: d.analista?.email ?? null };
}
