CREATE INDEX "Invoice_companyRfc_year_direction_status_idx"
ON "Invoice"("companyRfc", "year", "direction", "status");

CREATE INDEX "Invoice_counterpartyRfc_year_idx"
ON "Invoice"("counterpartyRfc", "year");

CREATE INDEX "Invoice_status_year_idx"
ON "Invoice"("status", "year");
