-- CreateEnum
CREATE TYPE "StatusAtendimento" AS ENUM ('AGUARDANDO', 'EM_ATENDIMENTO', 'FINALIZADO');

-- CreateTable
CREATE TABLE "atendimentos" (
    "id" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "observacoes" TEXT,
    "status" "StatusAtendimento" NOT NULL DEFAULT 'AGUARDANDO',
    "aberto_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iniciado_em" TIMESTAMP(3),
    "finalizado_em" TIMESTAMP(3),
    "cliente_id" TEXT NOT NULL,
    "setor_id" TEXT NOT NULL,
    "responsavel_id" TEXT,

    CONSTRAINT "atendimentos_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "atendimentos" ADD CONSTRAINT "atendimentos_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atendimentos" ADD CONSTRAINT "atendimentos_setor_id_fkey" FOREIGN KEY ("setor_id") REFERENCES "setores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atendimentos" ADD CONSTRAINT "atendimentos_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
