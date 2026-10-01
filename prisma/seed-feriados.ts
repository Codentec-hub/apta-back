// Feriados estaduais do Ceará e municipais de Fortaleza (os nacionais são
// calculados pelo motor de prazos). Idempotente: não duplica. Depois de
// rodar, as pendências futuras intocadas são refeitas.
import { recarregarFeriados } from "../src/obrigacoes/feriados.js";
import { gerarJanela, removerFuturasIntocadas } from "../src/obrigacoes/gerar-entregas.js";
import { prisma } from "../src/prisma.js";

const FERIADOS = [
  { data: "2000-03-19", descricao: "São José (padroeiro do Ceará)", uf: "CE", cidade: null },
  { data: "2000-03-25", descricao: "Data Magna do Ceará (Abolição)", uf: "CE", cidade: null },
  { data: "2000-04-13", descricao: "Aniversário de Fortaleza", uf: "CE", cidade: "Fortaleza" },
  { data: "2000-08-15", descricao: "Nossa Senhora da Assunção", uf: "CE", cidade: "Fortaleza" },
];

async function main(): Promise<void> {
  let criados = 0;
  for (const f of FERIADOS) {
    const data = new Date(f.data);
    const existe = await prisma.feriado.findFirst({ where: { data, uf: f.uf, cidade: f.cidade } });
    if (existe) continue;
    await prisma.feriado.create({ data: { ...f, data, recorrente: true } });
    criados += 1;
  }
  console.log(`Feriados: ${criados} criado(s), ${FERIADOS.length - criados} já existiam.`);

  await recarregarFeriados();
  const removidas = await removerFuturasIntocadas({});
  const geradas = await gerarJanela();
  console.log(`Pendências futuras: ${removidas} refeitas → ${geradas} geradas.`);
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
