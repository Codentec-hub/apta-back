// Disparo de e-mail pelo Resend (https://resend.com), via API HTTP — sem SDK.
//
// Configuração (variáveis de ambiente):
// - RESEND_API_KEY: chave da API. Sem ela, o envio por e-mail fica desligado.
// - EMAIL_REMETENTE: "Nome <endereco@dominio>"; o domínio precisa estar
//   verificado no Resend. Sem domínio verificado, o Resend só aceita
//   "onboarding@resend.dev" e só entrega para o e-mail da própria conta.
// - EMAIL_MODO=log: em desenvolvimento, não envia nada e só imprime o e-mail
//   no console (para testar o fluxo sem chave).

export interface Email {
  para: string;
  assunto: string;
  html: string;
  texto: string;
  responderPara?: string | null;
}

const REMETENTE_PADRAO = "Apta Contabilidade <onboarding@resend.dev>";

function modoLog(): boolean {
  return process.env.EMAIL_MODO === "log";
}

export function emailConfigurado(): boolean {
  return Boolean(process.env.RESEND_API_KEY) || modoLog();
}

// Lança Error com uma mensagem legível (vai para `erroEnvio` do protocolo).
export async function enviarEmail(email: Email): Promise<void> {
  if (modoLog()) {
    console.log(`[email:log] Para: ${email.para} | Assunto: ${email.assunto}\n${email.texto}`);
    return;
  }
  const chave = process.env.RESEND_API_KEY;
  if (!chave) {
    throw new Error("Envio por e-mail não configurado (falta RESEND_API_KEY no servidor)");
  }

  let resposta: globalThis.Response;
  try {
    resposta = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_REMETENTE ?? REMETENTE_PADRAO,
        to: [email.para],
        subject: email.assunto,
        html: email.html,
        text: email.texto,
        ...(email.responderPara ? { reply_to: email.responderPara } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Não foi possível falar com o serviço de e-mail: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!resposta.ok) {
    const corpo = (await resposta.json().catch(() => null)) as { message?: string } | null;
    throw new Error(`Serviço de e-mail recusou o envio (${resposta.status}): ${corpo?.message ?? resposta.statusText}`);
  }
}
