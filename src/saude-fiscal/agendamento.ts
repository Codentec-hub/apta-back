// Envio mensal automático do relatório de saúde fiscal (desligado por padrão;
// liga em Configurações de envio). De hora em hora confere: a partir do dia
// configurado, em horário comercial (9h-18h de Brasília), envia o relatório do
// mês anterior a todos os clientes ativos que estão na SIEG -- uma vez por mês.
import { prisma } from "../prisma.js";
import { mesesRecentes } from "../sieg/notas.js";
import { enviarLote, type Canal } from "./envio.js";

const agoraBrasilia = () => {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", day: "numeric", hour: "numeric", hour12: false })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { dia: Number(partes["day"]), hora: Number(partes["hour"]) };
};

async function verificar(): Promise<void> {
  const config = await prisma.configuracaoEnvio.findUnique({ where: { id: 1 } });
  if (!config?.saudeFiscalAutomatico) return;
  const { dia, hora } = agoraBrasilia();
  if (dia < config.saudeFiscalDia || hora < 9 || hora >= 18) return;
  const mesReferencia = mesesRecentes(2)[1]!; // mês anterior, já fechado
  if (config.saudeFiscalUltimoLote === mesReferencia) return;
  // Marca antes de enviar: um restart no meio não reenvia para quem já recebeu.
  await prisma.configuracaoEnvio.update({ where: { id: 1 }, data: { saudeFiscalUltimoLote: mesReferencia } });
  const canais = config.saudeFiscalCanais.filter((c): c is Canal => c === "email" || c === "whatsapp");
  const r = await enviarLote(mesReferencia, canais.length ? canais : ["email"], { automatico: true });
  console.log(`[saude-fiscal] lote ${mesReferencia}: ${r.enviados}/${r.total} enviados, ${r.semContato} sem contato, ${r.falhas.length} falha(s)`);
}

export function agendarSaudeFiscal(): void {
  const rodar = () => {
    verificar().catch((erro) => console.error("[saude-fiscal] falha no envio mensal", erro));
  };
  setTimeout(rodar, 60_000).unref();
  setInterval(rodar, 60 * 60 * 1000).unref();
}
