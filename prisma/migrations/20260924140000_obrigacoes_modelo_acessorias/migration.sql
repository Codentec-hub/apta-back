-- CreateEnum
CREATE TYPE "TipoDias" AS ENUM ('UTEIS', 'CORRIDOS');

-- AlterTable
ALTER TABLE "cliente_obrigacoes" ADD COLUMN     "tempo_previsto_minutos" INTEGER;

-- AlterTable
ALTER TABLE "setores" ADD COLUMN     "responsavel_id" TEXT;

-- AlterTable: regra no formato do Acessórias (um prazo por mês de entrega)
ALTER TABLE "tipos_obrigacao"
ADD COLUMN     "comentario_padrao" TEXT,
ADD COLUMN     "competencia_referente" INTEGER NOT NULL DEFAULT -1,
ADD COLUMN     "dias_antes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "entregas_por_mes" INTEGER[],
ADD COLUMN     "mininome" TEXT,
ADD COLUMN     "sabado_util" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tipo_dias_antes" "TipoDias" NOT NULL DEFAULT 'CORRIDOS';

-- Converte a regra anterior (periodicidade + dia + meses após a competência)
-- para os 12 meses de entrega + "competências referentes a".
UPDATE "tipos_obrigacao" SET
  "entregas_por_mes" = CASE "periodicidade"
    WHEN 'MENSAL' THEN array_fill(LEAST("dia_prazo_legal", 31), ARRAY[12])
    WHEN 'EVENTUAL' THEN array_fill(0, ARRAY[12])
    WHEN 'TRIMESTRAL' THEN ARRAY(
      SELECT CASE WHEN (((mm - "meses_apos_competencia" - 1 + 24) % 12) + 1) % 3 = 0
                  THEN LEAST("dia_prazo_legal", 31) ELSE 0 END
      FROM generate_series(1, 12) mm ORDER BY mm)
    WHEN 'ANUAL' THEN ARRAY(
      SELECT CASE WHEN mm = ((12 + "meses_apos_competencia" - 1) % 12) + 1
                  THEN LEAST("dia_prazo_legal", 31) ELSE 0 END
      FROM generate_series(1, 12) mm ORDER BY mm)
  END,
  "competencia_referente" = CASE
    WHEN "periodicidade" = 'ANUAL' THEN CASE WHEN "meses_apos_competencia" = 0 THEN 0 ELSE -12 END
    ELSE GREATEST(-3, LEAST(1, -"meses_apos_competencia"))
  END,
  "dias_antes" = COALESCE("dias_uteis_prazo_tecnico", 0),
  "tipo_dias_antes" = 'UTEIS';

UPDATE "tipos_obrigacao" SET "entregas_por_mes" = array_fill(0, ARRAY[12]) WHERE "entregas_por_mes" IS NULL;
ALTER TABLE "tipos_obrigacao" ALTER COLUMN "entregas_por_mes" SET DEFAULT ARRAY[0,0,0,0,0,0,0,0,0,0,0,0];
ALTER TABLE "tipos_obrigacao" ALTER COLUMN "entregas_por_mes" SET NOT NULL;

ALTER TABLE "tipos_obrigacao" DROP COLUMN "dia_prazo_legal",
DROP COLUMN "dias_uteis_prazo_tecnico",
DROP COLUMN "meses_apos_competencia",
DROP COLUMN "periodicidade";

-- DropEnum
DROP TYPE "Periodicidade";

-- CreateTable
CREATE TABLE "comentarios_entrega" (
    "id" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "obrigacao_id" TEXT NOT NULL,
    "usuario_id" TEXT,

    CONSTRAINT "comentarios_entrega_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comentarios_entrega_obrigacao_id_idx" ON "comentarios_entrega"("obrigacao_id");

-- AddForeignKey
ALTER TABLE "setores" ADD CONSTRAINT "setores_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comentarios_entrega" ADD CONSTRAINT "comentarios_entrega_obrigacao_id_fkey" FOREIGN KEY ("obrigacao_id") REFERENCES "obrigacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comentarios_entrega" ADD CONSTRAINT "comentarios_entrega_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

