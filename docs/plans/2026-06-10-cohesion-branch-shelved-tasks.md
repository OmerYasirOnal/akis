# Rafa kaldırılan `studio-cohesion-phase1` — yapılmak istenenlerin task listesi

> 2026-06-10 owner kararı: bu branch'ten **devam edilmeyecek**; önce main demo-edilebilir hale
> getirilecek. Branch silinmedi (origin'de duruyor, main `8ece4bb` + 37 commit, 0 geride —
> istenirse hâlâ `--ff-only` merge edilebilir). Bu doc, oradaki niyetin kaybolmaması için raf notu.
> Sağlık durumu: izole worktree'de tsc temiz + BE 1578/5-skip + FE 695 — YEŞİL (2026-06-10 ölçümü).

## Branch'in yaptığı işler (yeniden uygulanacaksa task listesi)

### A. Gerçek bug düzeltmeleri (UI'dan bağımsız değerli — en önce geri alınmaya adaylar)
1. **Atomik pre-build chat seed** — seedChat↔pipeline version-conflict yarışını eler: sohbet,
   session oluşturulurken version-0 yazımına gömülür (`sessions.routes.ts` + `Orchestrator.start`
   + `shared/session.ts`e additive `chat?` param). (`706e0bc`)
2. **Scribe "beklemede" düzeltmesi** — chat-seeded build'lerde sentetik `agent_start/end`
   (bus-only, gate-safe) + roster fallback. (`9d631bb`)
3. **Konuşma kaybolmasın** — reopen'da `mergeSpine()` (zengin lokal spine korunur) + build
   başında `session.chat` seed. (`b46f916`, `5ea666d`, `70217b6`)

### B. Chat kohezyonu (de-layer)
4. Tek 768px okuma kolonu (transcript + composer hizalı), ultrawide shell cap. (`51be744`)
5. De-layer: asistan düz metin, yalnız kullanıcı turu renkli; on-page yüzey. (`773bafe`)
6. Composer = tek yuvarlak kabuk + composer-içi model popover; "CANLI" rozeti kalktı. (`f26a0fb`)
7. Nötr ince scrollbar + stabil gutter (drawer dikişine yapışık bar yok). (`961acc7`, `581d23b`)
8. Composer kolona hizalı + alta dock + 8-pt boşluk + 44px gönder hedefi. (`d04e0ae`)

### C. Build görünürlüğü
9. Roster aktif ajanı vurgular + canlı caption. (`b4569d5`)
10. Sticky build-status barı (akış ekrandan kaysa da "derleniyor" görünür). (`30cf299`)

### D. Önizleme/drawer entegrasyonu
11. Chat header'da entegre "Önizleme" toggle (edge-tab emekli); üst-sağ buton-tabanlı aç/kapa.
    (`caa29c7`, `35002cd`, `e659e5a`, `95a4949`)
12. Drawer yokken push-split boşluğu olmasın (`--preview-w` hasRun'a bağlı). (`9cc898d`)
13. Sakin dikiş: tek hairline, padding paritesi; temiz chat↔drawer sınırı. (`1fcdca6`)
14. Drawer header'ı panel tab satırına gömülü; sahte tarayıcı-chrome satırı ve mükerrer
    "Canlı önizleme" başlığı kalktı; alt metrik satırı sadeleşti. (`0e94bbe`, `dddec9b`, `7a0f272`)
15. Önizleme kümesine Back/Forward iframe-nav kontrolleri. (`11ec3c7`)
16. Akıcı drag-to-resize önizleme genişliği + canlı px göstergesi. (`c8a9f9d`)

### E. Code sekmesi
17. Sürükleyerek boyutlanan dosya ağacı (`useTreeResizable`); slim açılış; gerçekten
    tutulabilir divider (absolute-over-seam). (`6efb75a`, `3609c20`, `9678f64`)

### F. Responsive (mobil-öncelik)
18. Mobil önizleme = snap noktalı sürüklenebilir bottom-sheet (peek/half/full). (`65c76a0`)
19. Roster lg altında yatay kaydırma şeridi; sm altında ikon-buton header. (`e103a1b`, `259bc62`)
20. Dosya ağacı dar mobil sheet'i domine etmesin (cap > px floor). (`f7428c4`)
21. Üst-nav marka sadeleşti (logo + AKIS); tutarlı header kontrol kümesi + TR etiketler.
    (`94381a6`, `a9d697a`)

### G. Phase 3 (hiç başlanmadı — owner opt-in'di)
22. Build sırasında canlı dosya ağacı.
23. "watch-me-verify": Trace koşusunu canlı izleme.
24. Önizlemede elemente tıkla → composer'a seç.

## Bilinen 2 defekt (geri alınırsa önce düzelt)
- **MEDIUM:** bottom-sheet `onGripUp` stale-closure (`PreviewDrawer.tsx:212` branch'te) —
  gerçek dokunmatik sürükleme bırakışta no-op; pointerup `e.clientY`/ref kalıbına geçir + piksel-drag testi ekle.
- **LOW:** ölü `getModeCached` export'u (`providersCache.ts:37`).

## İlgili
- Kök-neden notu: "build Proto'da patlıyor" = orchestrator stale-version yazımları
  (`Orchestrator.ts:368` vd.) — branch'ten bağımsız, main'de düzeltilecek (demo-blocker listesinde).
- Tasarım/plan dokümanları: `docs/superpowers/specs/2026-06-09-studio-cohesion-redesign-design.md`,
  `docs/superpowers/plans/2026-06-09-studio-cohesion-phase1.md`.
