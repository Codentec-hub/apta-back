import { prisma } from "../prisma.js";
import { definirFeriadosCadastrados } from "./prazos.js";

let carregado = false;

// Recarrega a tabela `feriados` para o motor de prazos. Chamar depois de
// qualquer alteração no cadastro de feriados.
export async function recarregarFeriados(): Promise<void> {
  const feriados = await prisma.feriado.findMany({ select: { data: true, recorrente: true, uf: true, cidade: true } });
  definirFeriadosCadastrados(feriados);
  carregado = true;
}

// Garante que o motor conhece os feriados cadastrados antes de calcular.
export async function garantirFeriados(): Promise<void> {
  if (!carregado) await recarregarFeriados();
}
