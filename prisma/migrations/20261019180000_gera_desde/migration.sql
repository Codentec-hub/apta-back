-- AlterTable
ALTER TABLE "cliente_obrigacoes" ADD COLUMN     "gera_desde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;


-- Vínculos existentes: valem desde quando foram criados.
UPDATE "cliente_obrigacoes" SET "gera_desde" = "created_at";
