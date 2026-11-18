-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "cnpj" TEXT;

-- CreateIndex
CREATE INDEX "leads_cnpj_idx" ON "leads"("cnpj");
