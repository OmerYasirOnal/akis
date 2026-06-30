# Demo-blocker audit — 2026-06-11 (bilinen A3/A4/B/C listesi DIŞINDAKİ yeni bulgular)

> Kaynak: 31-ajanlı adversarial audit workflow'u (9 boyut × bul→çürütmeye-çalış doğrulaması; 15
> doğrulandı, 5 bilinen-tekrarı elendi, 1 çürütüldü) + canlı Playwright turu (taze build
> `6dc232fd` Pomodoro, taze kullanıcı kaydı, History/Analytics süpürmesi) — main `a384b12`,
> :3000/:5173 canlı stack. Bilinen A3 kalanları / A4 / B1-B8 / C ve raf görevleri HARİÇTİR.
> (Owner'ın 2026-06-11 drawer bulguları — çift başlık/resize boşluğu/köşe radius — ayrı
> worktree'de `fix/preview-drawer-polish-2026-06-11` paketinde, bu listede değil.)

## P0 — Demo-blocker (önce bunlar; küçük, izole PR'lar)

1. **`confirmPush` terminal yazımları `updateResilient`'tan GEÇMİYOR** — A1 yarışının atlanan
   kardeşi. `Orchestrator.ts:709` `cur`'u bir kez okur; gerçek-GitHub push 5-15 sn sürer; bu
   sırada bir sohbet turu versiyonu artırırsa 748/766/**780**'deki bayat-versiyon yazımı
   "version conflict" → push GitHub'a GİTMİŞKEN kullanıcıya ham 500, oturum
   `awaiting_push_confirm`'de asılı (retry = AlreadyPushed karmaşası). Demo'nun final anında
   patlar. Çözüm: üç terminal yazımı da A1'in bounded retry kalıbına al. (Audit #5+#9, MED/HIGH)

2. **`PreviewRegistry.start()` re-entrancy yarışı** — `PreviewRegistry.ts:182` start()'ta
   oturum-başına kilit yok; probe/timeout dalları `procs.delete`/`set`'i sahiplik
   doğrulamadan KOŞULSUZ yapıyor. Prewarm + FE auto-run/Run çakışınca canlı süreç klobber →
   entry `failed`, port tutan öksüz dev-server. "Uygulamayı GÖR" anının sunucu tarafı. Çözüm:
   in-flight promise map ile oturum-başına serileştir + her state yazımına run-token guard'ı.
   (Audit #7, HIGH, demoBlocker) — A3 FE işiyle dosya çakışması yok ama A3 auto-run davranışı
   bu yarışın tetikleyicisini artırır; A3 merge'üyle birlikte düşünülmeli.

   > **GÜNCELLEME 2026-06-12 (PR #156 fix turu):** ROUTE-katmanı serileştirme GEMİDE —
   > `PreviewStartCoordinator` (preview.routes.ts, commit `6956a2f`) POST/auto-run/done-tap'ı
   > oturum-başına tek in-flight'a indirger + pending-done coalescing + restart öncesi canlılık
   > re-check'i. REGISTRY-İÇİ yarısı + üç ERTELENEN PR-yorumu BU pakete (P0-2) devredildi:
   > - **3399732516** (MED): restart, byte'lar DEĞİŞMEMİŞKEN de ateşliyor (confirmPush aynı
   >   session id'yle `done` yayar) → registry entry'sine code-digest ekle, digest aynıysa skip.
   > - **3399732530** (LOW): static→node dönüşen rebuild restart'ı cap-eviction döngüsünü
   >   tetikleyip BAŞKA oturumun canlı preview'ını evict edebilir → non-evicting prewarm flag'i.
   > - **3399732533'ün cap-eviction yarısı** (LOW): async pencerede cap doluysa aynı döngü;
   >   canlılık re-check'i kullanıcı Stop'unu çözüyor, eviction yarısı registry-içi işte.
   > Ayrıca run-token/ownership guard'ı (probe/timeout dallarının koşulsuz `procs` yazımları)
   > bu paketin çekirdeği olarak duruyor.

3. **Verify başarısızlığı YALAN söylüyor: "0 test / no real passing test was produced" — oysa
   testler koştu ve kanıt persist edildi** (CANLI yakalandı, 2026-06-11 gece, owner'ın gerçek
   "Kişisel Bütçe Takipçisi" oturumu `b8c0b5f9`, nöbetçi alarmı). Gerçek: e2e 11 kontrol koştu
   (boot + asset GEÇTİ), 1 sert başarısızlık = "missing literal" (`Sil` butonu — literal ancak
   kayıt EKLENİNCE DOM'a giriyor; statik probe taze DOM'da bulamıyor) + 3 interaktif kriter
   "skipped" (ay filtresi, bakiye karşılaştırması, reload-kalıcılığı — probe yürütemiyor).
   Ama: `TraceAgent.ts:64` `testsRun: token?.testsRun ?? 0` → token yoksa olay **testsRun:0**;
   `Orchestrator.ts:609` kanıttan bağımsız statik "no real passing test was produced" narrate
   ediyor (İngilizce; B6). Owner 5 kez kör Retry yaptı — aynı kod aynı sonucu verdi, mesaj
   neyin kırık olduğunu hiç söylemedi → iptal. Demonun verify anında ürün kendi kanıtına
   aykırı konuşuyor. Çözüm: (a) fail yolunda verify olayına kanıt sayılarını taşı
   (koşan/geçen/başarısız/ölçülemeyen) + narration'da başarısız senaryoyu ADIYLA söyle +
   recovery kartında değişiklik-isteği yolunu öner (kör Retry döngüsü yerine); (b) derive
   kalitesi: durum-bağımlı literal'ler (#122/#123 ailesinin kalan vakası) ve yürütülemeyen
   interaktif kriterler tek başına sert fail olmasın — "ölçülemedi" sınıfına düşsün.
   VerifyToken fail-closed disiplini AYNEN kalır; değişen yalnız raporlama dürüstlüğü.

### P0 prova bulguları (2026-06-12 sabahı, owner'ın Pomodoro CLI testi, oturum `651dda72`)
P0-3a tasarlandığı gibi çalıştı (sayılar + adlandırılmış senaryo + iki-dürüst-yol kartı canlıda
görüldü); ama test İKİ yeni bulgu çıkardı:
- **P1-9 · ANSI kaçış çöpü:** boot-fail nedenine sürecin stdout kuyruğu ham ANSI kodlarıyla
  (`[37m[0m[32m…`) giriyor → hata banner'ı/baloncuğu/güven raporu okunmaz. Yakalanan çıktı
  emit edilmeden ANSI-strip edilmeli (+ "uygulama çıktısı:" etiketi). Küçük backend işi
  (bootSmoke çıktı yakalama noktası).
- **P1-10 · Kabiliyet dürüstlüğü CLI vakası (owner ilkesinin yeni örneği):** Haiku, Pomodoro
  için TERMINAL/CLI uygulaması kurdu ve sohbette "Node.js ile yapacağım, böylece gerçek doğrulama
  ve canlı preview sunabilirim" DEDİ — oysa CLI port bağlamaz: preview imkânsız, boot-smoke
  "exited early (code 0)" (uygulama dashboard'unu basıp çıktı; kanıt: testsRun 0, tek senaryo
  boot smoke). Pipeline fail-closed DOĞRU davrandı; yalan CHAT katmanında. Çözüm iki uç:
  (a) AKIS/Scribe prompt'una CLI sınıfı için d38d456c-Python kuralının aynısı ("üretirim ama
  önizleyemem/doğrulayamam; web uygulaması/Node servisi önerebilirim"); (b) registry/bootSmoke
  "port bağlamadan code 0 ile çıktı" imzasını yakalayıp dürüst kopyaya çevirsin ("bu bir terminal
  uygulaması — canlı önizleme web uygulamaları ve Node servisleri için").
- Kopya cilası (LOW): "0 test (0 geçti, 1 başarısız…)" boot-fail vakasında çelişkili okunabiliyor —
  boot kendisi fail olunca "testler hiç koşamadı: boot başarısız" kalıbı daha net.

## P1 — Demo cilası (ucuz, sahnede görünür)

3. **Final kartı ham provider slug'ı basıyor** — "Yayınlandı … · anthropic" (`ChatThread.tsx:253`,
   `m.provider` verbatim; mock'ta "· mock"). Slug→görünen ad eşlemesi. (Audit #14, MED)
4. **Daralan spec çipi sonsuza dek "Spec onaylandı — inşa ediliyor"** — doğrulanmış/bitmiş/yeniden
   açılmış build'de bile (`SpecCard.tsx:88`, statik string; status prop'u yok). (Audit #15)
5. **Critic ajan şeridi hiç aktifleşmiyor** (canlı tur bulgusu): `code_review` olayı var ama
   Critic için `agent_start/agent_end` emit edilmiyor → şerit tüm build boyunca "beklemede",
   run bloğu ise "Kod incelemesi · Onaylandı · 7 bulgu" diyor. B2'nin (Scribe idle) Critic
   kardeşi. Çözüm: review yoluna agent_start/end ya da FE'de code_review→şerit eşlemesi.
6. **Push-gate kartı hedefsiz** (canlı tur bulgusu): bağlantısız kullanıcıda gate olayında
   `delivery` alanı yok → kart hedef göstermeden "Push'u onayla" diyor; onay paylaşılan env
   hedefine push'lar (A2 bilinçli varsayılanı) ama kart bunu SÖYLEMİYOR. Bağlantılı owner
   oturumlarında delivery geliyor (923717ad/d5e77d15/fbffbe89 olayları) → owner demosunu
   etkilemez; dürüstlük gediği. Env-fallback çözümlenince kartta hedefi (veya "paylaşılan
   sunucu hedefi" uyarısını) göster.
7. **B6 süpürmesi artık somut envanterli** (audit B6-inventory ×5): pipeline hata baloncukları
   (RunFailed/push failed/Critic), chat `(code) message` fallback'i, login/signup doğrulama
   hataları, aksiyon banner'ı (2 push kodu hariç tüm kodlar), Settings hataları — hepsi TR
   oturumda ham İngilizce. Tek i18n-mapping PR'ı ile kapatılabilir.
8. **Mikro-kopya paketi** (canlı tur): `/signup`'a client-side geçişte sekme başlığı "Analitik ·
   AKIS" kalıyor; logout sonrası URL eski route'ta kalıyor (landing render'lanırken
   `/analytics`); History/Analytics durum kopyası "Sana ihtiyaç var · gönder" tuhaf; Scribe TR
   spec'inde "User stories / Acceptance criteria / Out of scope / As a kullanıcı" karışımı
   (Scribe prompt'una başlık-yerelleştirme talimatı).

## P2 — Güven dürüstlüğü (ürünün hendeği; demo sonrası hızlı)

9. **GET-only smoke "✓ Doğrulandı" diyebiliyor** — `AKIS_ROUNDTRIP_VERIFY` kapalı olduğundan
   node-servis build'lerinde POST→GET kalıcılık + auth-guard probu hiç koşmuyor
   (`bootSmoke.ts:308`, `server.ts:285`). Demo env'inde `AKIS_ROUNDTRIP_VERIFY=1` aç (probe
   self-skip'li) ya da "Verified" kopyasını daralt. (Audit #12, MED)
10. **Simüle build'in DEMO rozeti kalıcı değil** — "✓ Verified" snapshot'tan (kalıcı), SIMULATED
    rozeti ring-buffer olayından (uçucu) → eski simüle build yeniden açılınca rozetsiz
    "Verified" görünür (`PreviewPanel.tsx:199` vd.). Kalıcı `testEvidence.demo`'yu da OR'la.
    (Audit #11, MED)
11. **Verify lane'in preview_status sızıntısı** — `#verify-<nonce>` sentetik oturumu canlı bus'a
    starting/ready/stopped basıyor; ölü URL'li hayalet buffer (dev-events kanıtlı). Emit'te
    VERIFY_SESSION_SUFFIX filtresi. (Audit #13)

## P3 — Güvenlik/sağlamlık (multi-user öncesi; akisflow'da şu an 2 kullanıcı)

12. **Preview data-plane + HMR WS tüneli AUTH'SUZ** — `/preview/:id/*` ve upgrade handler
    sahiplik kontrolü yapmıyor; UUID bilen herkes başka kullanıcının çalışan uygulamasına
    erişir (`preview.routes.ts:151`); kontrol rotaları scoped, data-plane değil.
    `accessiblePreviewSession`'ı proxy'ye + upgrade'e uygula. (Audit #8, MED — prod'a
    kullanıcı eklemeden ÖNCE şart)
13. Kalanlar (post-demo kuyruğu): transport-level fetch retry (`http.ts:153`, ECONNRESET →
    RunFailed); revoked-token 401→"yeniden bağlan" eşlemesi (`actionError.ts:22`); multi-run
    kenarları — non-aktif blok gate butonu AKTİF oturuma ateşliyor (`ChatThread.tsx:137`;
    RecoveryBubble'daki wrong-session fix'inin GateBubble'a uygulanmamış hali),
    `reactivateRun` önceki in-flight run'ı cancel'lamıyor (`ChatStudio.tsx:395`), F5 sonrası
    auto-preview/auto-open bastırılıyor (`ChatStudio.tsx:235`); keyless stüdyoda model çipi/
    yönlendirme yok (`AkisChat.tsx:746`).

14. **CI flake (canlı yakalandı, PR #157 push-koşusu):** `frontend/src/chat/history.test.tsx:153`
    deep-link testi `fake.connectedUrl`'i `waitFor`'suz senkron assert ediyor → mount-sonrası
    EventSource bağlanma efektiyle yarış; aynı SHA'da PR-koşusu geçti, push-koşusu kaldı.
    Tek satırlık sertleştirme: assert'i `waitFor` içine al. (LOW, CI hijyeni)

## Çürütülen / elenenler
- "Taze ziyaretçiye EN açılıyor, TR default yok" — ÇÜRÜTÜLDÜ (doğrulayıcı + canlı kanıt: taze
  kayıt TR selamlıyor; turda görülen EN selamlama eski sohbetin EN-yazılmış mesajıydı).
- 5 bulgu bilinen listenin tekrarı çıktı (B6 ailesi) → yukarıda envanter olarak birleştirildi.
- Trace "0s · 1 araç" metriği: statik app smoke'u gerçekten hızlı; ölçüm kozmetiği — analitik
  cilası (B4) ile birlikte ele alınabilir.

## Koordinasyon notları
- A3 kalanları + A4 = PARALEL SESSION'da (`fix/preview-staleness-a3-a4`) — bu listede yok.
- Drawer cilası (owner'ın 3 bulgusu) = `fix/preview-drawer-polish-2026-06-11` worktree ajanında;
  sunum-katmanı diff'i, A3 ile çakışmaması için lifecycle satırlarına dokunmuyor.
- P0-1 + P0-2 backend-only → A3/A4 FE işiyle dosya çakışmaz; ayrı worktree'lerde paralel
  koşulabilir. Tam audit çıktısı (kod alıntılı verdict'ler): workflow çıktı dosyasında
  (`tasks/w0o2juzcf.output`) + bu dokümana özetlendi.
