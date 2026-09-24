-- CreateEnum
CREATE TYPE "StatusDemanda" AS ENUM ('A_FAZER', 'EM_ANDAMENTO', 'CONCLUIDA');

-- CreateTable
CREATE TABLE "demandas" (
    "id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT,
    "status" "StatusDemanda" NOT NULL DEFAULT 'A_FAZER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setor_id" TEXT NOT NULL,
    "cliente_id" TEXT,
    "responsavel_id" TEXT,

    CONSTRAINT "demandas_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "demandas" ADD CONSTRAINT "demandas_setor_id_fkey" FOREIGN KEY ("setor_id") REFERENCES "setores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandas" ADD CONSTRAINT "demandas_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandas" ADD CONSTRAINT "demandas_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
