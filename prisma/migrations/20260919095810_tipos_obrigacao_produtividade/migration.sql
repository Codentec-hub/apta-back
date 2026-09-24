-- AlterTable
ALTER TABLE "obrigacoes" ADD COLUMN     "dispensada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prazo_tecnico" TIMESTAMP(3),
ADD COLUMN     "tempo_real_minutos" INTEGER,
ADD COLUMN     "tipo_id" TEXT;

-- CreateTable
CREATE TABLE "tipos_obrigacao" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tempo_previsto_minutos" INTEGER,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setor_id" TEXT NOT NULL,

    CONSTRAINT "tipos_obrigacao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tipos_obrigacao_nome_setor_id_key" ON "tipos_obrigacao"("nome", "setor_id");

-- AddForeignKey
ALTER TABLE "tipos_obrigacao" ADD CONSTRAINT "tipos_obrigacao_setor_id_fkey" FOREIGN KEY ("setor_id") REFERENCES "setores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obrigacoes" ADD CONSTRAINT "obrigacoes_tipo_id_fkey" FOREIGN KEY ("tipo_id") REFERENCES "tipos_obrigacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;
