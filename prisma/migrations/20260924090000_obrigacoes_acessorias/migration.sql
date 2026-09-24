-- CreateEnum
CREATE TYPE "Periodicidade" AS ENUM ('MENSAL', 'TRIMESTRAL', 'ANUAL', 'EVENTUAL');

-- CreateEnum
CREATE TYPE "AjustePrazo" AS ENUM ('ANTECIPAR', 'POSTERGAR', 'MANTER');

-- AlterTable
ALTER TABLE "obrigacoes" ADD COLUMN     "competencia" DATE,
ADD COLUMN     "entregue_por_id" TEXT;

-- AlterTable
ALTER TABLE "tipos_obrigacao" ADD COLUMN     "ajuste_prazo" "AjustePrazo" NOT NULL DEFAULT 'ANTECIPAR',
ADD COLUMN     "dia_prazo_legal" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "dias_uteis_prazo_tecnico" INTEGER,
ADD COLUMN     "gera_multa" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "meses_apos_competencia" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "periodicidade" "Periodicidade" NOT NULL DEFAULT 'MENSAL';

-- CreateTable
CREATE TABLE "regimes_tributarios" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regimes_tributarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regime_obrigacoes" (
    "regime_id" TEXT NOT NULL,
    "tipo_id" TEXT NOT NULL,

    CONSTRAINT "regime_obrigacoes_pkey" PRIMARY KEY ("regime_id","tipo_id")
);

-- CreateTable
CREATE TABLE "grupos_obrigacao" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grupos_obrigacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grupo_obrigacao_itens" (
    "grupo_id" TEXT NOT NULL,
    "tipo_id" TEXT NOT NULL,

    CONSTRAINT "grupo_obrigacao_itens_pkey" PRIMARY KEY ("grupo_id","tipo_id")
);

-- CreateTable
CREATE TABLE "cliente_obrigacoes" (
    "id" TEXT NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cliente_id" TEXT NOT NULL,
    "tipo_id" TEXT NOT NULL,
    "responsavel_id" TEXT,

    CONSTRAINT "cliente_obrigacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs_obrigacao" (
    "id" TEXT NOT NULL,
    "acao" TEXT NOT NULL,
    "detalhe" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "obrigacao_id" TEXT NOT NULL,
    "usuario_id" TEXT,

    CONSTRAINT "logs_obrigacao_pkey" PRIMARY KEY ("id")
);

-- Backfill: dados existentes passam a seguir o modelo do Acessórias.
-- 1) Competência = mês anterior ao prazo legal (regra "vence no mês
--    seguinte"), só onde não gera duplicidade cliente+tipo+competência.
WITH candidatas AS (
    SELECT "id",
           (date_trunc('month', "prazo" AT TIME ZONE 'America/Fortaleza') - interval '1 month')::date AS comp,
           row_number() OVER (
               PARTITION BY "cliente_id", "tipo_id",
                            date_trunc('month', "prazo" AT TIME ZONE 'America/Fortaleza')
               ORDER BY "created_at"
           ) AS rn
    FROM "obrigacoes"
    WHERE "tipo_id" IS NOT NULL
)
UPDATE "obrigacoes" o SET "competencia" = c.comp
FROM candidatas c WHERE o."id" = c."id" AND c.rn = 1;

-- 2) Quem entregou as já concluídas = responsável pelo prazo.
UPDATE "obrigacoes" SET "entregue_por_id" = "responsavel_id"
WHERE "concluida_em" IS NOT NULL;

-- 3) Toda obrigação que um cliente já tinha vira obrigação alocada na empresa.
INSERT INTO "cliente_obrigacoes" ("id", "cliente_id", "tipo_id")
SELECT gen_random_uuid()::text, "cliente_id", "tipo_id"
FROM "obrigacoes" WHERE "tipo_id" IS NOT NULL
GROUP BY "cliente_id", "tipo_id";

-- 4) Regimes tributários a partir dos já usados no cadastro de clientes.
INSERT INTO "regimes_tributarios" ("id", "nome")
SELECT gen_random_uuid()::text, r FROM (
    SELECT DISTINCT trim("regime_tributario") AS r FROM "clientes"
    WHERE "regime_tributario" IS NOT NULL AND trim("regime_tributario") <> ''
) x;

-- CreateIndex
CREATE UNIQUE INDEX "regimes_tributarios_nome_key" ON "regimes_tributarios"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "grupos_obrigacao_nome_key" ON "grupos_obrigacao"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "cliente_obrigacoes_cliente_id_tipo_id_key" ON "cliente_obrigacoes"("cliente_id", "tipo_id");

-- CreateIndex
CREATE INDEX "logs_obrigacao_obrigacao_id_idx" ON "logs_obrigacao"("obrigacao_id");

-- CreateIndex
CREATE INDEX "obrigacoes_competencia_idx" ON "obrigacoes"("competencia");

-- CreateIndex
CREATE UNIQUE INDEX "obrigacoes_cliente_id_tipo_id_competencia_key" ON "obrigacoes"("cliente_id", "tipo_id", "competencia");

-- AddForeignKey
ALTER TABLE "regime_obrigacoes" ADD CONSTRAINT "regime_obrigacoes_regime_id_fkey" FOREIGN KEY ("regime_id") REFERENCES "regimes_tributarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regime_obrigacoes" ADD CONSTRAINT "regime_obrigacoes_tipo_id_fkey" FOREIGN KEY ("tipo_id") REFERENCES "tipos_obrigacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grupo_obrigacao_itens" ADD CONSTRAINT "grupo_obrigacao_itens_grupo_id_fkey" FOREIGN KEY ("grupo_id") REFERENCES "grupos_obrigacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grupo_obrigacao_itens" ADD CONSTRAINT "grupo_obrigacao_itens_tipo_id_fkey" FOREIGN KEY ("tipo_id") REFERENCES "tipos_obrigacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cliente_obrigacoes" ADD CONSTRAINT "cliente_obrigacoes_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cliente_obrigacoes" ADD CONSTRAINT "cliente_obrigacoes_tipo_id_fkey" FOREIGN KEY ("tipo_id") REFERENCES "tipos_obrigacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cliente_obrigacoes" ADD CONSTRAINT "cliente_obrigacoes_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obrigacoes" ADD CONSTRAINT "obrigacoes_entregue_por_id_fkey" FOREIGN KEY ("entregue_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_obrigacao" ADD CONSTRAINT "logs_obrigacao_obrigacao_id_fkey" FOREIGN KEY ("obrigacao_id") REFERENCES "obrigacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_obrigacao" ADD CONSTRAINT "logs_obrigacao_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

