# AKIS — Bitirme Raporu (Graduation Report)

Final graduation report for the AKIS platform, prepared to the **FSMVÜ
Mühendislik Fakültesi — Lisans Bitirme Projesi Yazım Kılavuzu (Ek-3)** format.

## Contents

| File | Description |
| --- | --- |
| `AKIS_bitirme_raporu_final.docx` | The report (Word). Open in Word/Google Docs. |
| `AKIS_report_data.xlsx` | Companion spreadsheet — every table (5.1, 5.2, 8.1, 8.2, 8.3, 9.1) on its own sheet, plus the data behind each generated chart. |
| `charts/` | The 5 generated figures (PNG) embedded in the report. |
| `scripts/gen_charts.py` | Regenerates the charts (matplotlib). |
| `scripts/gen_xlsx.py` | Rebuilds the `.xlsx` from the report tables + chart data. |
| `scripts/surgery.py` | Reproducible docx edits (captions, lists, cross-refs, references, résumé). |

## Figures

- **Figure 4.1 / 4.2** — literature charts on AI code-verification reliability
  (SWE-bench resolution rates [4],[16],[17]; intrinsic self-correction [18]).
- **Figure 8.3 / 8.4 / 9.1** — the project's own results (tests, coverage, objectives).

## After opening in Word

Press **Ctrl+A** then **F9** (or *References ▸ Update Table*, and right-click
each field ▸ *Update Field*) to refresh:

- the **Table of Contents** (drops the old figure/table sub-lines automatically,
  since captions are no longer heading-styled, and fixes page numbers);
- the **List of Tables / List of Figures** page numbers (`PAGEREF` fields);
- the in-text **cross-references** to tables (`REF` fields).

Citation numbers `[1]`–`[18]` are in first-appearance order, matching the
REFERENCES list (FSMVÜ §3.7.2.2).
