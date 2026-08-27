CREATE TABLE "RadarState" (
    "id" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RadarState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "companyRfc" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "counterpartyRfc" TEXT NOT NULL,
    "counterpartyName" TEXT NOT NULL,
    "issuedAt" TEXT NOT NULL,
    "certifiedAt" TEXT NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "monthKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompetitorFile" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedAt" TIMESTAMP(3) NOT NULL,
    "recordsRead" INTEGER NOT NULL,
    "inserted" INTEGER NOT NULL,
    "duplicatesIgnored" INTEGER NOT NULL,
    "directions" JSONB NOT NULL,
    "companies" JSONB,
    CONSTRAINT "CompetitorFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerDirectoryMeta" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerDirectoryMeta_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerDirectoryEntry" (
    "taxId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    CONSTRAINT "CustomerDirectoryEntry_pkey" PRIMARY KEY ("taxId")
);

CREATE TABLE "CustomerSalesCache" (
    "taxId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerCode" TEXT,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "subtotalAmount" DECIMAL(18,2) NOT NULL,
    "activeMonths" INTEGER[],
    "monthly" JSONB NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerSalesCache_pkey" PRIMARY KEY ("taxId", "periodKey")
);

CREATE TABLE "CustomerCrossSnapshot" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "companyRfc" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "apiBaseUrl" TEXT NOT NULL,
    "apiPath" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerCrossSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerCrossEntry" (
    "snapshotId" TEXT NOT NULL,
    "taxId" TEXT NOT NULL,
    "crossed" BOOLEAN NOT NULL,
    "hasSales" BOOLEAN NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL,
    "ownCustomerSummary" JSONB,
    CONSTRAINT "CustomerCrossEntry_pkey" PRIMARY KEY ("snapshotId", "taxId")
);

CREATE INDEX "Invoice_sourceFileName_idx" ON "Invoice"("sourceFileName");
CREATE INDEX "Invoice_companyRfc_direction_idx" ON "Invoice"("companyRfc", "direction");
CREATE INDEX "Invoice_counterpartyRfc_idx" ON "Invoice"("counterpartyRfc");
CREATE INDEX "Invoice_year_month_idx" ON "Invoice"("year", "month");
CREATE INDEX "CompetitorFile_fileName_idx" ON "CompetitorFile"("fileName");
CREATE INDEX "CustomerDirectoryEntry_customerName_idx" ON "CustomerDirectoryEntry"("customerName");
CREATE INDEX "CustomerSalesCache_periodKey_idx" ON "CustomerSalesCache"("periodKey");
CREATE UNIQUE INDEX "CustomerCrossSnapshot_key_key" ON "CustomerCrossSnapshot"("key");
CREATE INDEX "CustomerCrossSnapshot_companyRfc_idx" ON "CustomerCrossSnapshot"("companyRfc");
CREATE INDEX "CustomerCrossEntry_taxId_idx" ON "CustomerCrossEntry"("taxId");

ALTER TABLE "CustomerCrossEntry"
ADD CONSTRAINT "CustomerCrossEntry_snapshotId_fkey"
FOREIGN KEY ("snapshotId") REFERENCES "CustomerCrossSnapshot"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
